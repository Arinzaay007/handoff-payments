-- Handoff: payment execution guards (migration 0003)
-- Run AFTER 0001_handoff_mainnet_schema.sql and 0002_claim_handoff_profile.sql.
--
-- What this migration does:
--   1. Adds the receipt state "transaction_submitted" (the payer's wallet broadcast the source tx).
--   2. Adds payer-scoped columns and indexes so the rolling 24-hour cap can be queried cheaply.
--   3. Adds integrity constraints so the database refuses impossible receipts:
--        - a source hash is required before any post-submission state,
--        - "settled" requires a Monad destination hash, a final amount, and a settlement time,
--        - source/destination hashes must be well-formed and unique,
--        - the per-payment cap and the eight launch source chains are enforced in the table.
--   4. Adds a trigger that stops receipts from moving backwards, changing once final, or
--      rewriting the amount, payer, or recipient after creation.
--   5. Adds reserve_payment_attempt(), which checks the 100 USDC rolling daily cap and inserts
--      the attempt inside one transaction guarded by a per-payer advisory lock. Two concurrent
--      quotes from the same wallet cannot both pass the cap.
--
-- Existing rows: constraints are added NOT VALID so that any pre-existing data does not block
-- the migration. New and updated rows are always checked.
-- Service-role only: the new function is revoked from public, anon, and authenticated.

-- 1. Receipt state for "Transaction submitted". Used only inside functions and checks as text.
alter type public.payment_status add value if not exists 'transaction_submitted' before 'source_confirmed';

-- 2. Payer-scoped columns.
alter table public.payment_attempts
  add column if not exists payer_address text,
  add column if not exists quote_expires_at timestamptz,
  add column if not exists relay_status text,
  add column if not exists relay_status_updated_at timestamptz;

-- 3. Integrity constraints (NOT VALID: enforced for every new or changed row).
alter table public.payment_attempts
  add constraint payment_attempts_payer_address_shape
  check (payer_address is null or payer_address ~ '^0x[0-9a-f]{40}$') not valid;

alter table public.payment_attempts
  add constraint payment_attempts_source_currency_shape
  check (source_currency ~ '^0x[0-9a-fA-F]{40}$') not valid;

alter table public.payment_attempts
  add constraint payment_attempts_source_chain_launch
  check (source_chain_id in (1, 8453, 42161, 10, 137, 56, 43114, 42220)) not valid;

-- Launch per-payment cap: 25 USDC = 25,000,000 six-decimal minor units.
alter table public.payment_attempts
  add constraint payment_attempts_per_payment_cap
  check (source_amount <= 25000000) not valid;

alter table public.payment_attempts
  add constraint payment_attempts_source_tx_hash_shape
  check (source_tx_hash is null or source_tx_hash ~ '^0x[0-9a-fA-F]{64}$') not valid;

alter table public.payment_attempts
  add constraint payment_attempts_destination_tx_hash_shape
  check (destination_tx_hash is null or destination_tx_hash ~ '^0x[0-9a-fA-F]{64}$') not valid;

-- A transaction-submitted receipt must carry the payer's source transaction hash.
alter table public.payment_attempts
  add constraint payment_attempts_submitted_requires_source_hash
  check (status::text <> 'transaction_submitted' or source_tx_hash is not null) not valid;

-- Anything after submission (source confirmed, routing, settled) must have a source hash.
alter table public.payment_attempts
  add constraint payment_attempts_post_submission_requires_source_hash
  check (status::text not in ('source_confirmed', 'routing', 'settled') or source_tx_hash is not null) not valid;

-- "Settled" is only possible with a Monad destination transaction, a final amount that meets the
-- minimum Relay promised, and a settlement timestamp.
alter table public.payment_attempts
  add constraint payment_attempts_settled_requires_monad_receipt
  check (
    status::text <> 'settled'
    or (
      destination_tx_hash is not null
      and settled_at is not null
      and final_destination_amount is not null
      and (minimum_destination_amount is null or final_destination_amount >= minimum_destination_amount)
    )
  ) not valid;

alter table public.payment_attempts
  add constraint payment_attempts_failed_requires_reason
  check (status::text <> 'failed' or failure_code is not null) not valid;

-- 4. Indexes: one source hash belongs to one attempt; fast rolling-window cap lookups per payer.
create unique index if not exists payment_attempts_source_tx_hash_key
  on public.payment_attempts (lower(source_tx_hash))
  where source_tx_hash is not null;

create index if not exists payment_attempts_payer_recent_idx
  on public.payment_attempts (payer_address, created_at desc)
  where payer_address is not null;

-- 5. Integrity trigger. Receipts move forward only, final receipts are immutable, and the
--    amount, payer, recipient, and route cannot be rewritten after the quote is created.
create or replace function public.guard_payment_attempt_update()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_old_rank integer;
  v_new_rank integer;
begin
  if new.id is distinct from old.id
     or new.source_amount is distinct from old.source_amount
     or new.payer_address is distinct from old.payer_address
     or new.recipient_profile_id is distinct from old.recipient_profile_id
     or new.recipient_wallet_id is distinct from old.recipient_wallet_id
     or new.source_chain_id is distinct from old.source_chain_id
     or new.source_currency is distinct from old.source_currency
     or new.destination_chain_id is distinct from old.destination_chain_id
     or new.destination_currency is distinct from old.destination_currency
     or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'Payment attempt route and amount are immutable after quote.' using errcode = 'P0001';
  end if;

  if old.source_tx_hash is not null and new.source_tx_hash is distinct from old.source_tx_hash then
    raise exception 'Source transaction hash is immutable once recorded.' using errcode = 'P0001';
  end if;

  if old.destination_tx_hash is not null and new.destination_tx_hash is distinct from old.destination_tx_hash then
    raise exception 'Destination transaction hash is immutable once recorded.' using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status then
    if old.status::text in ('settled', 'failed', 'refunded') then
      raise exception 'Payment attempt is already final.' using errcode = 'P0001';
    end if;

    -- Failure and refund can be reached from any open state. Everything else only moves forward.
    if new.status::text not in ('failed', 'refunded') then
      v_old_rank := case old.status::text
        when 'quote_created' then 0
        when 'awaiting_sender' then 1
        when 'transaction_submitted' then 2
        when 'source_confirmed' then 3
        when 'routing' then 4
        else 9
      end;
      v_new_rank := case new.status::text
        when 'quote_created' then 0
        when 'awaiting_sender' then 1
        when 'transaction_submitted' then 2
        when 'source_confirmed' then 3
        when 'routing' then 4
        when 'settled' then 5
        else 9
      end;
      if v_new_rank < v_old_rank then
        raise exception 'Payment status cannot move backwards.' using errcode = 'P0001';
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists payment_attempts_guard_update on public.payment_attempts;
create trigger payment_attempts_guard_update
before update on public.payment_attempts
for each row execute function public.guard_payment_attempt_update();

-- 6. Atomic reservation with the launch caps. The caller (server) passes the cap values from its
--    configuration. The advisory lock serialises concurrent quotes from the same payer wallet.
--    The window is rolling 24 hours. An attempt counts while it is either:
--      - a source transaction was recorded (funds may be in flight), or
--      - its quote is still live and it has not failed or been refunded (quote reservation).
--    Abandoned, expired quotes stop counting once they expire.
create or replace function public.reserve_payment_attempt(
  p_payer_address text,
  p_recipient_profile_id uuid,
  p_recipient_wallet_id uuid,
  p_source_chain_id integer,
  p_source_currency text,
  p_source_amount numeric,
  p_minimum_destination_amount numeric,
  p_relay_request_id text,
  p_quote_expires_at timestamptz,
  p_per_payment_cap numeric,
  p_daily_cap numeric
)
returns public.payment_attempts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payer text := lower(coalesce(p_payer_address, ''));
  -- Launch ceilings live here as well as in the server config. A caller can lower the caps, never raise them.
  v_per_payment_cap numeric := least(coalesce(p_per_payment_cap, 25000000), 25000000);
  v_daily_cap numeric := least(coalesce(p_daily_cap, 100000000), 100000000);
  v_used numeric;
  v_row public.payment_attempts%rowtype;
begin
  if v_payer !~ '^0x[0-9a-f]{40}$' then
    raise exception 'A valid payer wallet is required.' using errcode = '22023';
  end if;
  if p_source_amount is null or p_source_amount <= 0 then
    raise exception 'Enter a valid payment amount.' using errcode = '22023';
  end if;
  if p_source_amount > v_per_payment_cap then
    raise exception 'PER_PAYMENT_CAP_EXCEEDED' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('handoff-payer:' || v_payer, 0));

  select coalesce(sum(pa.source_amount), 0) into v_used
  from public.payment_attempts as pa
  where pa.payer_address = v_payer
    and pa.created_at > now() - interval '24 hours'
    and (
      pa.source_tx_hash is not null
      or (pa.status::text not in ('failed', 'refunded') and pa.quote_expires_at > now())
    );

  if v_used + p_source_amount > v_daily_cap then
    raise exception 'DAILY_CAP_EXCEEDED' using errcode = 'P0001';
  end if;

  insert into public.payment_attempts (
    payer_address,
    recipient_profile_id,
    recipient_wallet_id,
    source_chain_id,
    source_currency,
    source_amount,
    destination_chain_id,
    destination_currency,
    minimum_destination_amount,
    relay_request_id,
    quote_expires_at,
    status
  ) values (
    v_payer,
    p_recipient_profile_id,
    p_recipient_wallet_id,
    p_source_chain_id,
    lower(p_source_currency),
    p_source_amount,
    143,
    'USDC',
    p_minimum_destination_amount,
    p_relay_request_id,
    p_quote_expires_at,
    'quote_created'
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.reserve_payment_attempt(text, uuid, uuid, integer, text, numeric, numeric, text, timestamptz, numeric, numeric)
  from public, anon, authenticated;
revoke all on function public.guard_payment_attempt_update() from public, anon, authenticated;
