-- Handoff-to-Handoff USDC transfers on Monad.
--
-- The sender signs one short-lived EIP-3009 authorization. The server has no custody of sender
-- funds: it stores only the signed authorization long enough for its separately funded relayer to
-- broadcast transferWithAuthorization(), then marks completion only after an exact USDC receipt.

create table if not exists public.handoff_transfers (
  id uuid primary key default gen_random_uuid(),
  sender_profile_id uuid not null references public.profiles(id) on delete restrict,
  sender_wallet_id uuid not null references public.recipient_wallets(id) on delete restrict,
  sender_wallet_address text not null check (sender_wallet_address ~ '^0x[0-9a-f]{40}$'),
  recipient_profile_id uuid not null references public.profiles(id) on delete restrict,
  recipient_wallet_id uuid not null references public.recipient_wallets(id) on delete restrict,
  recipient_wallet_address text not null check (recipient_wallet_address ~ '^0x[0-9a-f]{40}$'),
  amount numeric(78, 0) not null check (amount > 0),
  authorization_nonce text not null unique check (authorization_nonce ~ '^0x[0-9a-f]{64}$'),
  authorization_valid_after bigint not null,
  authorization_valid_before bigint not null check (authorization_valid_before > authorization_valid_after),
  authorization_signature text check (authorization_signature is null or authorization_signature ~ '^0x[0-9a-f]{130}$'),
  relayer_tx_hash text unique check (relayer_tx_hash is null or relayer_tx_hash ~ '^0x[0-9a-f]{64}$'),
  status text not null default 'created' check (status in ('created', 'authorized', 'submitted', 'settled', 'failed', 'expired')),
  failure_code text,
  created_at timestamptz not null default now(),
  authorized_at timestamptz,
  submitted_at timestamptz,
  settled_at timestamptz,
  updated_at timestamptz not null default now(),
  check (sender_profile_id <> recipient_profile_id),
  check ((status in ('authorized', 'submitted', 'settled') and authorization_signature is not null) or status not in ('authorized', 'submitted', 'settled')),
  check ((status in ('submitted', 'settled') and relayer_tx_hash is not null) or status not in ('submitted', 'settled'))
);

create index if not exists handoff_transfers_sender_created_idx
  on public.handoff_transfers(sender_profile_id, created_at desc);
create index if not exists handoff_transfers_recipient_created_idx
  on public.handoff_transfers(recipient_profile_id, created_at desc);

-- Terms are immutable. The only permitted lifecycle is:
-- created → authorized → submitted → settled, with created/authorized/submitted allowed to end as
-- expired or failed. A submitted transfer is never retried as a new transfer with the same nonce.
create or replace function public.guard_handoff_transfer_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.id is distinct from old.id
     or new.sender_profile_id is distinct from old.sender_profile_id
     or new.sender_wallet_id is distinct from old.sender_wallet_id
     or new.sender_wallet_address is distinct from old.sender_wallet_address
     or new.recipient_profile_id is distinct from old.recipient_profile_id
     or new.recipient_wallet_id is distinct from old.recipient_wallet_id
     or new.recipient_wallet_address is distinct from old.recipient_wallet_address
     or new.amount is distinct from old.amount
     or new.authorization_nonce is distinct from old.authorization_nonce
     or new.authorization_valid_after is distinct from old.authorization_valid_after
     or new.authorization_valid_before is distinct from old.authorization_valid_before then
    raise exception 'Handoff transfer terms are immutable.' using errcode = 'P0001';
  end if;

  if old.authorization_signature is not null and new.authorization_signature is distinct from old.authorization_signature then
    raise exception 'Handoff authorization is immutable once recorded.' using errcode = 'P0001';
  end if;
  if old.relayer_tx_hash is not null and new.relayer_tx_hash is distinct from old.relayer_tx_hash then
    raise exception 'Relayer transaction hash is immutable once recorded.' using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status then
    if old.status in ('settled', 'failed', 'expired') then
      raise exception 'Handoff transfer is already final.' using errcode = 'P0001';
    end if;
    if not (
      (old.status = 'created' and new.status in ('authorized', 'expired', 'failed'))
      or (old.status = 'authorized' and new.status in ('submitted', 'expired', 'failed'))
      or (old.status = 'submitted' and new.status in ('settled', 'failed'))
    ) then
      raise exception 'Handoff transfer status cannot move this way.' using errcode = 'P0001';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists handoff_transfer_update_guard on public.handoff_transfers;
create trigger handoff_transfer_update_guard
before update on public.handoff_transfers
for each row execute function public.guard_handoff_transfer_update();

-- Reserving happens in one transaction and locks on the sender profile. This enforces the same
-- 25 USDC-per-transfer and 100 USDC-rolling-24h launch limits as the external payment flow.
create or replace function public.reserve_handoff_transfer(
  p_sender_profile_id uuid,
  p_sender_wallet_id uuid,
  p_sender_wallet_address text,
  p_recipient_profile_id uuid,
  p_recipient_wallet_id uuid,
  p_recipient_wallet_address text,
  p_amount numeric,
  p_authorization_nonce text,
  p_valid_after bigint,
  p_valid_before bigint,
  p_per_transfer_cap numeric,
  p_daily_cap numeric
)
returns public.handoff_transfers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender_wallet text;
  v_recipient_wallet text;
  v_used numeric;
  v_row public.handoff_transfers%rowtype;
  v_per_transfer_cap numeric := least(coalesce(p_per_transfer_cap, 25000000), 25000000);
  v_daily_cap numeric := least(coalesce(p_daily_cap, 100000000), 100000000);
begin
  if p_sender_profile_id is null or p_recipient_profile_id is null or p_sender_profile_id = p_recipient_profile_id then
    raise exception 'INVALID_RECIPIENT' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > v_per_transfer_cap then
    raise exception 'PER_TRANSFER_CAP_EXCEEDED' using errcode = 'P0001';
  end if;
  if p_authorization_nonce !~ '^0x[0-9a-f]{64}$' or p_valid_after >= p_valid_before or p_valid_before <= extract(epoch from now())::bigint then
    raise exception 'INVALID_AUTHORIZATION' using errcode = '22023';
  end if;

  select lower(wallet_address) into v_sender_wallet
  from public.recipient_wallets
  where id = p_sender_wallet_id and profile_id = p_sender_profile_id and is_active = true and chain_id = 143;
  select lower(wallet_address) into v_recipient_wallet
  from public.recipient_wallets
  where id = p_recipient_wallet_id and profile_id = p_recipient_profile_id and is_active = true and chain_id = 143;
  if v_sender_wallet is null or v_recipient_wallet is null
     or v_sender_wallet <> lower(p_sender_wallet_address)
     or v_recipient_wallet <> lower(p_recipient_wallet_address) then
    raise exception 'INVALID_TRANSFER_ACCOUNT' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('handoff-internal-sender:' || p_sender_profile_id::text, 0));
  select coalesce(sum(amount), 0) into v_used
  from public.handoff_transfers
  where sender_profile_id = p_sender_profile_id
    and created_at > now() - interval '24 hours'
    and (status in ('submitted', 'settled') or (status in ('created', 'authorized') and authorization_valid_before > extract(epoch from now())::bigint));
  if v_used + p_amount > v_daily_cap then
    raise exception 'DAILY_CAP_EXCEEDED' using errcode = 'P0001';
  end if;

  insert into public.handoff_transfers (
    sender_profile_id, sender_wallet_id, sender_wallet_address,
    recipient_profile_id, recipient_wallet_id, recipient_wallet_address,
    amount, authorization_nonce, authorization_valid_after, authorization_valid_before, status
  ) values (
    p_sender_profile_id, p_sender_wallet_id, lower(p_sender_wallet_address),
    p_recipient_profile_id, p_recipient_wallet_id, lower(p_recipient_wallet_address),
    p_amount, lower(p_authorization_nonce), p_valid_after, p_valid_before, 'created'
  ) returning * into v_row;
  return v_row;
end;
$$;

-- Atomic compare-and-set: exactly one valid confirmation can change a created intent to authorized.
create or replace function public.record_handoff_transfer_authorization(
  p_transfer_id uuid,
  p_sender_profile_id uuid,
  p_signature text
)
returns public.handoff_transfers
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.handoff_transfers%rowtype;
begin
  update public.handoff_transfers
  set status = 'authorized', authorization_signature = lower(p_signature), authorized_at = now()
  where id = p_transfer_id
    and sender_profile_id = p_sender_profile_id
    and status = 'created'
    and authorization_valid_before > extract(epoch from now())::bigint
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.record_handoff_transfer_submission(
  p_transfer_id uuid,
  p_sender_profile_id uuid,
  p_tx_hash text
)
returns public.handoff_transfers
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.handoff_transfers%rowtype;
begin
  update public.handoff_transfers
  set status = 'submitted', relayer_tx_hash = lower(p_tx_hash), submitted_at = now()
  where id = p_transfer_id
    and sender_profile_id = p_sender_profile_id
    and status = 'authorized'
    and authorization_valid_before > extract(epoch from now())::bigint
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.settle_handoff_transfer(
  p_transfer_id uuid,
  p_tx_hash text
)
returns public.handoff_transfers
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.handoff_transfers%rowtype;
begin
  update public.handoff_transfers
  set status = 'settled', settled_at = now()
  where id = p_transfer_id and status = 'submitted' and relayer_tx_hash = lower(p_tx_hash)
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.expire_handoff_transfer(
  p_transfer_id uuid,
  p_sender_profile_id uuid
)
returns public.handoff_transfers
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.handoff_transfers%rowtype;
begin
  update public.handoff_transfers
  set status = 'expired'
  where id = p_transfer_id
    and sender_profile_id = p_sender_profile_id
    and status in ('created', 'authorized')
    and authorization_valid_before <= extract(epoch from now())::bigint
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on table public.handoff_transfers from public, anon, authenticated;
revoke all on function public.reserve_handoff_transfer(uuid, uuid, text, uuid, uuid, text, numeric, text, bigint, bigint, numeric, numeric) from public, anon, authenticated;
revoke all on function public.record_handoff_transfer_authorization(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.record_handoff_transfer_submission(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.settle_handoff_transfer(uuid, text) from public, anon, authenticated;
revoke all on function public.expire_handoff_transfer(uuid, uuid) from public, anon, authenticated;
