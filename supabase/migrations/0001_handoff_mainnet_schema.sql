-- Handoff: production data model
-- Apply with the Supabase CLI or SQL editor. This intentionally enables RLS
-- and exposes no direct anonymous access to payment identities or requests.

create extension if not exists pgcrypto;

create type public.alias_provider as enum ('handoff', 'x', 'instagram');
create type public.alias_status as enum ('verified', 'revoked', 'pending');
create type public.request_status as enum ('active', 'paid', 'expired', 'cancelled');
create type public.payment_status as enum (
  'quote_created', 'awaiting_sender', 'source_confirmed', 'routing',
  'settled', 'failed', 'refunded'
);

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  auth_subject text not null unique,
  username text not null unique,
  username_normalized text not null unique,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_shape check (
    username_normalized ~ '^[a-z0-9_]{3,24}$'
  )
);

create table public.recipient_wallets (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  chain_id integer not null default 143 check (chain_id = 143),
  wallet_address text not null,
  is_active boolean not null default true,
  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (chain_id, wallet_address),
  constraint recipient_wallets_evm_address check (wallet_address ~ '^0x[0-9a-fA-F]{40}$')
);

create unique index recipient_wallets_one_active_per_profile
  on public.recipient_wallets(profile_id)
  where is_active;

-- provider_subject is the stable provider ID. Never use only a mutable @handle as proof of ownership.
create table public.social_aliases (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  provider public.alias_provider not null,
  provider_subject text not null,
  display_handle text not null,
  normalized_handle text not null,
  status public.alias_status not null default 'pending',
  verified_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_subject),
  unique (provider, normalized_handle),
  constraint aliases_handle_present check (length(normalized_handle) > 0)
);

create table public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  public_id text not null unique,
  recipient_profile_id uuid not null references public.profiles(id) on delete restrict,
  recipient_wallet_id uuid not null references public.recipient_wallets(id) on delete restrict,
  output_chain_id integer not null default 143 check (output_chain_id = 143),
  output_currency text not null default 'USDC',
  -- USDC's smallest units; null means any amount.
  requested_amount_minor numeric(78, 0),
  memo text,
  expires_at timestamptz,
  status public.request_status not null default 'active',
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  constraint payment_requests_positive_amount check (
    requested_amount_minor is null or requested_amount_minor > 0
  ),
  constraint payment_requests_memo_length check (char_length(coalesce(memo, '')) <= 140)
);

create table public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  payment_request_id uuid references public.payment_requests(id) on delete set null,
  recipient_profile_id uuid not null references public.profiles(id) on delete restrict,
  recipient_wallet_id uuid not null references public.recipient_wallets(id) on delete restrict,
  source_chain_id integer not null,
  source_currency text not null,
  source_amount numeric(78, 0) not null check (source_amount > 0),
  destination_chain_id integer not null default 143 check (destination_chain_id = 143),
  destination_currency text not null default 'USDC',
  minimum_destination_amount numeric(78, 0),
  final_destination_amount numeric(78, 0),
  relay_request_id text unique,
  source_tx_hash text,
  destination_tx_hash text,
  status public.payment_status not null default 'quote_created',
  idempotency_key uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  settled_at timestamptz,
  failure_code text,
  failure_message text
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  profile_id uuid references public.profiles(id) on delete set null,
  event_type text not null,
  actor_subject text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger social_aliases_updated_at before update on public.social_aliases
for each row execute function public.set_updated_at();
create trigger payment_attempts_updated_at before update on public.payment_attempts
for each row execute function public.set_updated_at();

-- Everything goes through server routes using the service-role key after verifying the session.
-- Never put the service-role key in client-side code.
alter table public.profiles enable row level security;
alter table public.recipient_wallets enable row level security;
alter table public.social_aliases enable row level security;
alter table public.payment_requests enable row level security;
alter table public.payment_attempts enable row level security;
alter table public.audit_events enable row level security;
