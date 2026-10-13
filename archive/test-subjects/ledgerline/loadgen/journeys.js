// Customer behaviour for LedgerLine. Account ids are acct-00001..acct-20000 (seeded). A fixed pool of "hot" payers
// keeps balances healthy; payees are spread across the whole population.
import crypto from 'node:crypto';
const acct = (n) => `acct-${String(n).padStart(5, '0')}`;
export const journeys = [
  { name: 'transfer', weight: 55, run: async (c) => {
    const from = acct(1 + c.rand(2000)), to = acct(2001 + c.rand(18000));
    await c.http('POST', '/api/transfers', { from, to, amountCents: 100 + c.rand(40000), currency: 'USD' }, { 'idempotency-key': crypto.randomUUID() });
  } },
  { name: 'fx-transfer', weight: 10, run: async (c) => {
    // payer accounts 1..2000 include EUR/GBP holders (id % 5 == 3 or 4 -> EUR / GBP)
    const n = 1 + c.rand(2000), cur = n % 5 === 3 ? 'EUR' : n % 5 === 4 ? 'GBP' : 'USD';
    await c.http('POST', '/api/transfers', { from: acct(n), to: acct(2001 + c.rand(18000)), amountCents: 100 + c.rand(20000), currency: cur === 'USD' ? 'EUR' : 'USD' }, { 'idempotency-key': crypto.randomUUID() });
  } },
  { name: 'profile', weight: 25, run: async (c) => { await c.http('GET', `/api/accounts/${acct(1 + c.rand(20000))}/risk-profile`); } },
  { name: 'statement', weight: 10, run: async (c) => { await c.http('GET', `/api/statements/${acct(1 + c.rand(2000))}`); } },
];
