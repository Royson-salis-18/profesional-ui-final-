#!/bin/bash
set -euo pipefail
N="${SEED_ACCOUNTS:-20000}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
create table accounts (
  id text primary key, owner text not null, status text not null, currency text not null,
  kyc_level int not null, created_at timestamptz not null default now()
);
insert into accounts(id, owner, status, currency, kyc_level, created_at)
select 'acct-' || lpad(g::text, 5, '0'), 'owner-' || g, 'active',
       (array['USD','USD','USD','EUR','GBP'])[1 + g % 5], 1 + g % 3, now() - ((g % 900) || ' days')::interval
from generate_series(1, ${N}) g;
insert into accounts(id, owner, status, currency, kyc_level) values ('acct-fees', 'ledgerline-treasury', 'active', 'USD', 3);
analyze accounts;
SQL
