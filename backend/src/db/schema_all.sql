-- ─────────────────────────────────────────────────────────────────────────────
-- Cumulant (Circle Arc / EVM) — Supabase persistence schema.
-- Run this whole file ONCE in the Supabase SQL Editor.
--
-- IMPORTANT vs the legacy schema: bundle ids are synthetic STRING labels
-- (e.g. "CMLT-MID-MED"), NOT uuids, and the EVM backend does not maintain a
-- `bundles` row per id. So every `bundle_id` is a plain TEXT column with NO
-- foreign key. (The old uuid + FK schema rejected inserts with
-- "invalid input syntax for type uuid: CMLT-…".)
--
-- Safe to re-run: drops + recreates (the tables are empty on a fresh project).
-- ─────────────────────────────────────────────────────────────────────────────

drop table if exists price_alerts cascade;
drop table if exists ppn_vaults cascade;
drop table if exists nav_snapshots cascade;
drop table if exists transactions cascade;
drop table if exists positions cascade;
drop table if exists legs cascade;
drop table if exists bundles cascade;

-- Bundle directory (optional / mostly unused on EVM — bundles are synthesised
-- client-side from the live feed). Kept so getBundleById has a table to read.
create table bundles (
  id text primary key,
  name text unique not null,
  risk_tier int check (risk_tier in (50, 70, 90)),
  resolution_date date,
  issue_price numeric,
  status text not null default 'active',
  description text,
  theme text,
  onchain_tx_signature text,
  onchain_finalized_at timestamptz,
  onchain_finalize_tx text,
  created_at timestamptz not null default now()
);

create table legs (
  id uuid primary key default gen_random_uuid(),
  bundle_id text not null,
  market_id text not null,
  question text not null,
  probability numeric not null,
  weight numeric not null,
  status text not null default 'active',
  resolution_value numeric,
  polymarket_url text,
  leg_index int,
  onchain_resolved_at timestamptz,
  onchain_resolve_tx text,
  created_at timestamptz not null default now()
);

create table positions (
  id uuid primary key default gen_random_uuid(),
  bundle_id text not null,
  wallet_address text not null,
  tokens_held numeric not null,
  entry_price numeric not null,
  deposited_usdc numeric not null,
  created_at timestamptz not null default now()
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  bundle_id text not null,
  wallet_address text not null,
  type text not null check (type in ('deposit', 'redemption', 'transfer')),
  amount_usdc numeric not null,
  tokens numeric not null,
  fee_usdc numeric not null,
  tx_signature text,
  onchain_tx_signature text,
  created_at timestamptz not null default now()
);

create table nav_snapshots (
  id uuid primary key default gen_random_uuid(),
  bundle_id text not null,
  nav numeric not null,
  legs_data jsonb not null,
  created_at timestamptz not null default now()
);

-- Protected notes + tranche overlay (tranche_* columns are the off-chain
-- waterfall metadata; null for a vanilla protected-note deposit).
create table ppn_vaults (
  id uuid primary key default gen_random_uuid(),
  bundle_id text not null,
  wallet_address text not null,
  principal_usdc numeric not null,
  yield_deployed_usdc numeric not null default 0,
  estimated_apy numeric not null default 0.08,
  vault_address text,
  status text not null default 'active',
  maturity_date date,
  note_seed_hex text,
  onchain_tx_signature text,
  redemption_tx_signature text,
  divest_tx_signature text,
  maturity_ts bigint,
  tranche_kind text check (tranche_kind in ('senior', 'mezzanine', 'junior')),
  tranche_attach double precision,
  tranche_detach double precision,
  price_per_token double precision,
  created_at timestamptz not null default now()
);

create table price_alerts (
  id uuid primary key default gen_random_uuid(),
  bundle_id text not null,
  wallet_address text not null,
  alert_type text not null check (alert_type in ('above', 'below', 'change_percent')),
  threshold numeric not null,
  triggered boolean not null default false,
  triggered_at timestamptz,
  triggered_nav numeric,
  created_at timestamptz not null default now()
);

create index idx_legs_bundle_id on legs(bundle_id);
create index idx_positions_bundle_id on positions(bundle_id);
create index idx_positions_wallet_address on positions(wallet_address);
create index idx_transactions_bundle_id on transactions(bundle_id);
create index idx_transactions_wallet_address on transactions(wallet_address);
create index idx_nav_snapshots_bundle_id on nav_snapshots(bundle_id);
create index idx_nav_snapshots_created_at on nav_snapshots(created_at);
create index idx_ppn_vaults_wallet on ppn_vaults(wallet_address);
create index idx_ppn_vaults_bundle on ppn_vaults(bundle_id);
create index idx_ppn_vaults_onchain_tx_signature on ppn_vaults (onchain_tx_signature) where onchain_tx_signature is not null;
create index idx_ppn_vaults_tranche_kind on ppn_vaults (tranche_kind) where tranche_kind is not null;
create index idx_price_alerts_wallet on price_alerts(wallet_address);
create index idx_price_alerts_bundle on price_alerts(bundle_id);
create index idx_price_alerts_active on price_alerts(bundle_id) where triggered = false;
