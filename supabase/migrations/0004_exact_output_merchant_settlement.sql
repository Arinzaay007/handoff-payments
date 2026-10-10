-- Handoff: exact-output merchant settlement and sender-paid route costs
-- Run AFTER 0001_handoff_mainnet_schema.sql, 0002_claim_handoff_profile.sql, and
-- 0003_payment_execution_guards.sql.
--
-- The amount entered into Handoff is a required Monad-USDC merchant output, never an assumed
-- source-USDC input. Relay calculates and signs the actual payer source debit. This migration
-- stores each value separately, applies payer caps to the quote debit, and makes an exact-output
-- receipt impossible to settle unless Monad verified exactly the requested USDC amount.

-- 1. Immutable quote accounting. Existing legacy/exact-input rows stay valid; they are not
-- retroactively represented as exact-output payments.
alter table public.payment_attempts
  add column if not exists requested_destination_amount numeric(78, 0),
  add column if not exists quoted_source_amount numeric(78, 0),
  add column if not exists actual_source_amount numeric(78, 0),
  add column if not exists quoted_route_fee_amount numeric(78, 0),
  add column if not exists exact_output boolean not null default false,
  add column if not exists true_exact_output boolean not null default false;

-- Keep legacy receipts readable. They are deliberately marked false, so they can never be
-- presented as this new merchant-safe exact-output mode.
update public.payment_attempts
set
  requested_destination_amount = coalesce(requested_destination_amount, minimum_destination_amount),
  quoted_source_amount = coalesce(quoted_source_amount, source_amount),
  actual_source_amount = case
    when actual_source_amount is null and source_tx_hash is not null then source_amount
    else actual_source_amount
  end,
  quoted_route_fee_amount = coalesce(quoted_route_fee_amount, 0)
where requested_destination_amount is null
   or quoted_source_amount is null
   or quoted_route_fee_amount is null
   or (actual_source_amount is null and source_tx_hash is not null);

alter table public.payment_attempts
  add constraint payment_attempts_requested_destination_positive
  check (requested_destination_amount is null or requested_destination_amount > 0) not valid,
  add constraint payment_attempts_quoted_source_positive
  check (quoted_source_amount is null or quoted_source_amount > 0) not valid,
  add constraint payment_attempts_actual_source_positive
  check (actual_source_amount is null or actual_source_amount > 0) not valid,
  add constraint payment_attempts_route_fee_nonnegative
  check (quoted_route_fee_amount is null or quoted_route_fee_amount >= 0) not valid,
  add constraint payment_attempts_exact_output_quote_shape
  check (
    not exact_output
    or (
      true_exact_output
      and requested_destination_amount is not null
      and quoted_source_amount is not null
      and quoted_route_fee_amount is not null
      and source_amount = quoted_source_amount
      and minimum_destination_amount = requested_destination_amount
    )
  ) not valid,
  add constraint payment_attempts_exact_output_actual_source
  check (
    not exact_output
    or actual_source_amount is null
    or actual_source_amount = quoted_source_amount
  ) not valid,
  add constraint payment_attempts_confirmed_requires_actual_source
  check (
    status::text not in ('source_confirmed', 'routing', 'settled')
    or actual_source_amount is not null
  ) not valid,
  add constraint payment_attempts_exact_output_settlement
  check (
    not exact_output
    or status::text <> 'settled'
    or final_destination_amount = requested_destination_amount
  ) not valid;

-- 2. The route and quote terms can never be rewritten. actual_source_amount is written at most
-- once, after Relay confirms the signed source deposit. The old update guard is replaced in place.
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
     or new.idempotency_key is distinct from old.idempotency_key
     or new.requested_destination_amount is distinct from old.requested_destination_amount
     or new.quoted_source_amount is distinct from old.quoted_source_amount
     or new.quoted_route_fee_amount is distinct from old.quoted_route_fee_amount
     or new.exact_output is distinct from old.exact_output
     or new.true_exact_output is distinct from old.true_exact_output then
    raise exception 'Payment attempt route and quote terms are immutable after quote.' using errcode = 'P0001';
  end if;

  if old.actual_source_amount is not null and new.actual_source_amount is distinct from old.actual_source_amount then
    raise exception 'Actual source amount is immutable once confirmed.' using errcode = 'P0001';
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

-- 3. Atomically reserve an exact-output attempt. p_source_amount is Relay's quoted and signed
-- payer debit, and is the only amount used for the payment and rolling-daily caps.
drop function if exists public.reserve_payment_attempt(text, uuid, uuid, integer, text, numeric, numeric, text, timestamptz, numeric, numeric);

create function public.reserve_payment_attempt(
  p_payer_address text,
  p_recipient_profile_id uuid,
  p_recipient_wallet_id uuid,
  p_source_chain_id integer,
  p_source_currency text,
  p_source_amount numeric,
  p_requested_destination_amount numeric,
  p_quoted_route_fee_amount numeric,
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
  -- Launch ceilings live here as well as in server config. A caller can lower caps, never raise them.
  v_per_payment_cap numeric := least(coalesce(p_per_payment_cap, 25000000), 25000000);
  v_daily_cap numeric := least(coalesce(p_daily_cap, 100000000), 100000000);
  v_used numeric;
  v_row public.payment_attempts%rowtype;
begin
  if v_payer !~ '^0x[0-9a-f]{40}$' then
    raise exception 'A valid payer wallet is required.' using errcode = '22023';
  end if;
  if p_source_amount is null or p_source_amount <= 0 then
    raise exception 'Relay did not quote a valid payer amount.' using errcode = '22023';
  end if;
  if p_requested_destination_amount is null or p_requested_destination_amount <= 0 then
    raise exception 'Relay did not guarantee a valid recipient amount.' using errcode = '22023';
  end if;
  if p_minimum_destination_amount is distinct from p_requested_destination_amount then
    raise exception 'Relay did not guarantee the requested exact output.' using errcode = '22023';
  end if;
  if p_quoted_route_fee_amount is null or p_quoted_route_fee_amount < 0 then
    raise exception 'Relay did not quote valid route costs.' using errcode = '22023';
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
    quoted_source_amount,
    quoted_route_fee_amount,
    requested_destination_amount,
    destination_chain_id,
    destination_currency,
    minimum_destination_amount,
    relay_request_id,
    quote_expires_at,
    exact_output,
    true_exact_output,
    status
  ) values (
    v_payer,
    p_recipient_profile_id,
    p_recipient_wallet_id,
    p_source_chain_id,
    lower(p_source_currency),
    p_source_amount,
    p_source_amount,
    p_quoted_route_fee_amount,
    p_requested_destination_amount,
    143,
    'USDC',
    p_minimum_destination_amount,
    p_relay_request_id,
    p_quote_expires_at,
    true,
    true,
    'quote_created'
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.reserve_payment_attempt(text, uuid, uuid, integer, text, numeric, numeric, numeric, numeric, text, timestamptz, numeric, numeric)
  from public, anon, authenticated;
revoke all on function public.guard_payment_attempt_update() from public, anon, authenticated;
