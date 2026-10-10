-- Handoff: atomic, server-only username claim.
-- Run this migration after 0001_handoff_mainnet_schema.sql.
-- The app calls it only with a verified Dynamic session and the Supabase service key.

create unique index if not exists recipient_wallets_chain_address_lower_unique
  on public.recipient_wallets(chain_id, lower(wallet_address));

create or replace function public.claim_handoff_profile(
  p_auth_subject text,
  p_username text,
  p_display_name text,
  p_wallet_address text
)
returns table (
  profile_id uuid,
  username text,
  display_name text,
  wallet_address text,
  chain_id integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_wallet public.recipient_wallets%rowtype;
begin
  if p_auth_subject is null or char_length(trim(p_auth_subject)) = 0 then
    raise exception 'Authenticated user is required.' using errcode = '22023';
  end if;
  if p_username !~ '^[a-z0-9_]{3,24}$' then
    raise exception 'Username must be 3–24 lowercase letters, numbers, or underscores.' using errcode = '22023';
  end if;
  if p_wallet_address !~ '^0x[0-9a-fA-F]{40}$' then
    raise exception 'A valid Monad recipient wallet is required.' using errcode = '22023';
  end if;

  select pr.* into v_profile
  from public.profiles as pr
  where pr.auth_subject = p_auth_subject
  for update;

  if found then
    if v_profile.username_normalized <> p_username then
      raise exception 'This Dynamic account already owns @%.', v_profile.username using errcode = 'P0001';
    end if;
    if p_display_name is not null and char_length(trim(p_display_name)) > 0 then
      update public.profiles
      set display_name = left(trim(p_display_name), 80)
      where id = v_profile.id
      returning * into v_profile;
    end if;
  else
    begin
      insert into public.profiles (auth_subject, username, username_normalized, display_name)
      values (p_auth_subject, p_username, p_username, nullif(left(trim(coalesce(p_display_name, '')), 80), ''))
      returning * into v_profile;
    exception when unique_violation then
      if exists (select 1 from public.profiles where username_normalized = p_username) then
        raise exception 'That Handoff username is unavailable.' using errcode = '23505';
      end if;
      raise;
    end;
  end if;

  -- Every column reference below is table-qualified. RETURNS TABLE creates OUT variables named
  -- profile_id, chain_id, wallet_address, and so on; unqualified names would be ambiguous.
  select rw.* into v_wallet
  from public.recipient_wallets as rw
  where rw.profile_id = v_profile.id and rw.chain_id = 143 and rw.is_active
  for update;

  if found then
    if lower(v_wallet.wallet_address) <> lower(p_wallet_address) then
      raise exception 'Your active recipient wallet cannot be changed in this flow.' using errcode = 'P0001';
    end if;
  else
    if exists (
      select 1 from public.recipient_wallets as other_rw
      where other_rw.chain_id = 143
        and lower(other_rw.wallet_address) = lower(p_wallet_address)
        and other_rw.profile_id <> v_profile.id
    ) then
      raise exception 'This wallet is already linked to another Handoff user.' using errcode = '23505';
    end if;

    insert into public.recipient_wallets (profile_id, chain_id, wallet_address, is_active, confirmed_at)
    values (v_profile.id, 143, lower(p_wallet_address), true, now())
    returning * into v_wallet;
  end if;

  insert into public.audit_events (profile_id, event_type, actor_subject, metadata)
  values (v_profile.id, 'profile_claimed', p_auth_subject, jsonb_build_object('chain_id', 143));

  return query
  select v_profile.id, v_profile.username, v_profile.display_name, v_wallet.wallet_address, v_wallet.chain_id;
end;
$$;

revoke all on function public.claim_handoff_profile(text, text, text, text) from public, anon, authenticated;
