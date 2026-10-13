#!/bin/bash
# Balances for every account, an empty (insert-only) entries table, and a read-only role for reporting.
# SEED_FEE_ENTRIES = how much fee history the treasury account already holds. A new environment has none;
# a bank that has been live for a year has millions.
set -euo pipefail
N="${SEED_ACCOUNTS:-20000}"
FEE_ROWS="${SEED_FEE_ENTRIES:-2000}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
create table balances (account_id text primary key, balance_cents bigint not null check (balance_cents >= 0));
insert into balances select 'acct-' || lpad(g::text, 5, '0'), 50000000 from generate_series(1, ${N}) g;
insert into balances values ('acct-fees', 0), ('acct-clearing', 0);
create table entries (
  id bigserial primary key, txn_id uuid not null, account_id text not null, amount_cents bigint not null,
  currency text not null default 'USD', created_at timestamptz not null default now()
);
create index entries_account_idx on entries(account_id, id);
create index entries_txn_idx on entries(txn_id);
-- historical fees: each is a balanced pair (credit treasury, debit the clearing account) so the book still sums to zero
with h as (select gen_random_uuid() t, 1 + g % 500 a, now() - (g || ' seconds')::interval ts from generate_series(1, ${FEE_ROWS}) g)
insert into entries(txn_id, account_id, amount_cents, created_at)
select t, 'acct-fees', a, ts from h union all select t, 'acct-clearing', -a, ts from h;
-- opening balances reflect the seeded fee history; fee_rollup records how far the treasury row has been rolled up
update balances set balance_cents = (select coalesce(sum(amount_cents),0) from entries where account_id='acct-fees') where account_id='acct-fees';
-- the clearing account's opening balance exactly offsets its seeded debits, so it starts at 0
create table fee_rollup (last_entry_id bigint not null);
insert into fee_rollup select coalesce(max(id),0) from entries;
create role reporting login password '${REPORTING_DB_PASSWORD:-reporting-secret}';
grant select on entries, balances to reporting;
analyze;
SQL
