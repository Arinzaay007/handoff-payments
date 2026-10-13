-- Handoff: fixed payment-request execution guards
-- Run after migrations 0001 through 0005. This binds a fixed request to the exact-output quote
-- and moves the request to paid only when the associated payment attempt has a verified settlement.

-- A request link is immutable once attached to an attempt. The one permitted attachment is made
-- inside reserve_payment_request_attempt(), after the request row has been locked and verified.
create or replace function public.guard_payment_attempt_request_link()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.payment_request_id is distinct from old.payment_request_id
     and current_setting('handoff.internal_payment_request_reservation', true) is distinct from 'true' then
    raise exception 'Payment request binding is immutable.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists payment_attempts_request_link_guard on public.payment_attempts;
create trigger payment_attempts_request_link_guard
before update on public.payment_attempts
for each row execute function public.guard_payment_attempt_request_link();

-- Change a request to paid only when the already-guarded payment attempt becomes settled. A request
-- may have reached its display expiry while its valid, pre-expiry payment was still routing; that
-- valid receipt is allowed to supersede expired, but cancellation is never superseded.
create or replace function public.settle_fixed_payment_request()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.payment_request_id is not null
     and new.status::text = 'settled'
     and old.status::text is distinct from 'settled' then
    update public.payment_requests
    set status = 'paid', paid_at = coalesce(new.settled_at, now())
    where id = new.payment_request_id
      and status in ('active', 'expired');
    if not found then
      raise exception 'Payment request is not eligible to settle.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists payment_attempts_settle_fixed_request on public.payment_attempts;
create trigger payment_attempts_settle_fixed_request
after update of status on public.payment_attempts
for each row execute function public.settle_fixed_payment_request();

-- Atomically reserves an attempt for a fixed request. The lock prevents amount substitution,
-- recipient substitution, concurrent duplicate checkout, and cancellation racing with checkout.
create or replace function public.reserve_payment_request_attempt(
  p_payment_request_public_id text,
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
  v_request public.payment_requests%rowtype;
  v_attempt public.payment_attempts%rowtype;
begin
  select * into v_request
  from public.payment_requests
  where public_id = p_payment_request_public_id
  for update;

  if not found then
    raise exception 'REQUEST_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_request.status::text <> 'active' then
    raise exception 'REQUEST_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  if v_request.expires_at is not null and v_request.expires_at <= now() then
    update public.payment_requests set status = 'expired' where id = v_request.id and status = 'active';
    raise exception 'REQUEST_EXPIRED' using errcode = 'P0001';
  end if;
  if v_request.requested_amount_minor is distinct from p_requested_destination_amount then
    raise exception 'REQUEST_AMOUNT_MISMATCH' using errcode = 'P0001';
  end if;
  if v_request.recipient_profile_id is distinct from p_recipient_profile_id
     or v_request.recipient_wallet_id is distinct from p_recipient_wallet_id then
    raise exception 'REQUEST_RECIPIENT_MISMATCH' using errcode = 'P0001';
  end if;

  -- A request has one live payment path. An abandoned, unsigned quote is marked failed after its
  -- expiry before a replacement can be made. A submitted/routing attempt is never replaced.
  update public.payment_attempts
  set status = 'failed', failure_code = 'QUOTE_EXPIRED'
  where payment_request_id = v_request.id
    and status in ('quote_created', 'awaiting_sender')
    and source_tx_hash is null
    and quote_expires_at <= now();

  if exists (
    select 1 from public.payment_attempts
    where payment_request_id = v_request.id
      and status not in ('failed', 'refunded')
  ) then
    raise exception 'REQUEST_PAYMENT_IN_PROGRESS' using errcode = 'P0001';
  end if;

  select * into v_attempt from public.reserve_payment_attempt(
    p_payer_address,
    p_recipient_profile_id,
    p_recipient_wallet_id,
    p_source_chain_id,
    p_source_currency,
    p_source_amount,
    p_requested_destination_amount,
    p_quoted_route_fee_amount,
    p_minimum_destination_amount,
    p_relay_request_id,
    p_quote_expires_at,
    p_per_payment_cap,
    p_daily_cap
  );

  perform set_config('handoff.internal_payment_request_reservation', 'true', true);
  update public.payment_attempts
  set payment_request_id = v_request.id
  where id = v_attempt.id
  returning * into v_attempt;
  return v_attempt;
end;
$$;

-- Owner cancellation uses the same row lock. It refuses cancellation after any live quote or
-- payment path has started, so a customer can never pay a request that has been shown as cancelled.
create or replace function public.cancel_fixed_payment_request(
  p_payment_request_public_id text,
  p_recipient_profile_id uuid
)
returns public.payment_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.payment_requests%rowtype;
begin
  select * into v_request
  from public.payment_requests
  where public_id = p_payment_request_public_id
    and recipient_profile_id = p_recipient_profile_id
  for update;
  if not found or v_request.status::text <> 'active' then
    raise exception 'REQUEST_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.payment_attempts
    where payment_request_id = v_request.id
      and status not in ('failed', 'refunded')
  ) then
    raise exception 'REQUEST_PAYMENT_IN_PROGRESS' using errcode = 'P0001';
  end if;
  update public.payment_requests
  set status = 'cancelled'
  where id = v_request.id
  returning * into v_request;
  return v_request;
end;
$$;

revoke all on function public.reserve_payment_request_attempt(text, text, uuid, uuid, integer, text, numeric, numeric, numeric, numeric, text, timestamptz, numeric, numeric)
  from public, anon, authenticated;
revoke all on function public.cancel_fixed_payment_request(text, uuid)
  from public, anon, authenticated;
revoke all on function public.guard_payment_attempt_request_link() from public, anon, authenticated;
revoke all on function public.settle_fixed_payment_request() from public, anon, authenticated;
