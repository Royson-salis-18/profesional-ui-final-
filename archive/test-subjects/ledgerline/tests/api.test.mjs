// LedgerLine API tests: every endpoint of every service, the transfer saga, double-entry invariants and idempotency.
// Run against a live stack:  EXPOSE=1 ../lab/up.sh ledgerline ll-00-baseline  &&  node --test tests/api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connect } from 'nats';
import { EDGE, SVC, NATS_URL, get, post, req, uid, eventually } from './helpers.mjs';

const idem = () => ({ 'idempotency-key': crypto.randomUUID() });
// Seeded: acct-00001..20000. Currency by id%5: 0,1,2 -> USD, 3 -> EUR, 4 -> GBP. Balance 500,000.00 each.
const USD_A = 'acct-00010', USD_B = 'acct-02500', EUR_A = 'acct-00003', GBP_A = 'acct-00004';
const bal = async (id) => (await get(SVC.ledger, `/balances/${id}`)).json.balanceCents;

test('every service answers /healthz, /readyz and /metrics', async () => {
  for (const [name, base] of Object.entries(SVC)) {
    assert.equal((await get(base, '/healthz')).json?.status, 'ok', `${name} /healthz`);
    assert.equal((await get(base, '/readyz')).status, 200, `${name} /readyz`);
    assert.match((await get(base, '/metrics')).text, /process_resident_memory_bytes/, `${name} /metrics`);
  }
  assert.equal((await get(EDGE, '/healthz')).status, 200);
  assert.equal((await get(EDGE, '/api/nothing-here')).status, 404);
});

// ---------------------------------------------------------------- accounts
test('accounts: detail, summary, risk-profile, 404', async () => {
  let r = await get(SVC.accounts, `/accounts/${USD_A}`);
  assert.equal(r.status, 200); assert.equal(r.json.currency, 'USD'); assert.equal(r.json.status, 'active');
  assert.equal((await get(SVC.accounts, `/accounts/${EUR_A}`)).json.currency, 'EUR');
  assert.equal((await get(SVC.accounts, `/accounts/${GBP_A}`)).json.currency, 'GBP');
  r = await get(SVC.accounts, `/accounts/${USD_A}/summary`);
  assert.equal(r.status, 200); assert.ok(r.json.age_days >= 0 && r.json.kyc_level >= 1);
  r = await get(SVC.accounts, `/accounts/${USD_A}/risk-profile`);
  assert.equal(r.status, 200); assert.equal(typeof r.json.risk.score, 'number');
  assert.equal((await get(SVC.accounts, '/accounts/nope')).status, 404);
  assert.equal((await get(SVC.accounts, '/accounts/nope/summary')).status, 404);
  assert.equal((await get(SVC.accounts, '/accounts/nope/risk-profile')).status, 404);
});

// ---------------------------------------------------------------- fraud-screening
test('fraud-screening: allow, large amount raises score, validation, velocity triggers review', async () => {
  let r = await post(SVC.fraud, '/screen', { accountId: uid('f'), amountCents: 1000 });
  assert.equal(r.status, 200); assert.equal(r.json.decision, 'allow'); assert.equal(r.json.score, 0);
  r = await post(SVC.fraud, '/screen', { accountId: uid('f'), amountCents: 600000 });
  assert.ok(r.json.score >= 40);
  assert.equal((await post(SVC.fraud, '/screen', {})).status, 400);
  assert.equal((await get(SVC.fraud, '/assess')).status, 400);
  assert.equal(typeof (await get(SVC.fraud, '/assess?accountId=x')).json.score, 'number');
  const hot = uid('velocity'); let last;
  for (let i = 0; i < 25; i++) last = await post(SVC.fraud, '/screen', { accountId: hot, amountCents: 600000 });
  assert.equal(last.json.decision, 'review', 'high velocity + large amount is held');
});

// ---------------------------------------------------------------- fx-provider + fx-rates
test('fx-provider and fx-rates: rates, identity, validation, unknown pair', async () => {
  let r = await get(SVC.fxProvider, '/v1/rate?from=USD&to=EUR');
  assert.equal(r.status, 200); assert.ok(Math.abs(r.json.rate - 0.92) < 0.01);
  assert.equal((await get(SVC.fxProvider, '/v1/rate?from=USD&to=XXX')).status, 404);
  r = await get(SVC.fx, '/rates?from=USD&to=EUR');
  assert.equal(r.status, 200); assert.ok(Math.abs(r.json.rate - 0.92) < 0.01);
  assert.equal((await get(SVC.fx, '/rates?from=USD&to=EUR')).json.source, 'cache', 'second read is served from the 5s cache');
  r = await get(SVC.fx, '/rates?from=GBP&to=GBP');
  assert.equal(r.json.rate, 1); assert.equal(r.json.source, 'identity');
  assert.equal((await get(SVC.fx, '/rates?from=USD')).status, 400);
});

// ---------------------------------------------------------------- ledger (double entry)
test('ledger: validation, posting, fee, idempotent txn id, insufficient funds, balances', async () => {
  assert.equal((await post(SVC.ledger, '/entries', { from: USD_A })).status, 400);
  assert.equal((await get(SVC.ledger, '/balances/nope')).status, 404);
  const [a0, b0, f0] = [await bal(USD_A), await bal(USD_B), await bal('acct-fees')];
  const txnId = crypto.randomUUID();
  let r = await post(SVC.ledger, '/entries', { txnId, from: USD_A, to: USD_B, amountCents: 100000 });
  assert.equal(r.status, 201); assert.equal(r.json.feeCents, 100, '10 bps fee');
  assert.equal(await bal(USD_A), a0 - 100000 - 100, 'payer debited amount + fee');
  assert.equal(await bal(USD_B), b0 + 100000, 'payee credited amount');
  assert.equal(await bal('acct-fees'), f0 + 100, 'treasury credited the fee');
  r = await post(SVC.ledger, '/entries', { txnId, from: USD_A, to: USD_B, amountCents: 100000 });
  assert.equal(r.json.duplicate, true);
  assert.equal(await bal(USD_A), a0 - 100000 - 100, 'a replayed txn id never posts twice');
  r = await post(SVC.ledger, '/entries', { txnId: crypto.randomUUID(), from: USD_A, to: USD_B, amountCents: 99999999999 });
  assert.equal(r.status, 409);
});

// ---------------------------------------------------------------- transfers (the saga)
test('transfers: validation errors', async () => {
  const body = { from: USD_A, to: USD_B, amountCents: 1000 };
  assert.equal((await post(EDGE, '/api/transfers', body)).status, 400, 'Idempotency-Key is required');
  assert.equal((await post(EDGE, '/api/transfers', { ...body, to: USD_A }, idem())).status, 400, 'same account');
  assert.equal((await post(EDGE, '/api/transfers', { ...body, amountCents: 0 }, idem())).status, 400);
  assert.equal((await post(EDGE, '/api/transfers', { ...body, to: 'acct-99999' }, idem())).status, 404, 'unknown account');
});

test('transfers: same-currency transfer moves money exactly and is replay-safe', async () => {
  const [a0, b0] = [await bal(USD_A), await bal(USD_B)];
  const key = { 'idempotency-key': crypto.randomUUID() };
  const body = { from: USD_A, to: USD_B, amountCents: 25000, currency: 'USD' };
  const r = await post(EDGE, '/api/transfers', body, key);
  assert.equal(r.status, 201); assert.equal(r.json.status, 'completed'); assert.equal(r.json.feeCents, 25);
  assert.equal(await bal(USD_A), a0 - 25025); assert.equal(await bal(USD_B), b0 + 25000);
  const again = await post(EDGE, '/api/transfers', body, key);
  assert.equal(again.status, 200); assert.equal(again.json.replayed, true); assert.equal(again.json.transferId, r.json.transferId);
  assert.equal(await bal(USD_A), a0 - 25025, 'the replay did not move money again');
});

test('transfers: cross-currency converts through fx-rates', async () => {
  const [a0, b0] = [await bal(EUR_A), await bal(USD_B)];
  // EUR_A holds EUR; sending a 10,000-USD-cent amount converts USD -> EUR (rate ~0.92)
  const r = await post(EDGE, '/api/transfers', { from: EUR_A, to: USD_B, amountCents: 10000, currency: 'USD' }, idem());
  assert.equal(r.status, 201);
  const debited = a0 - (await bal(EUR_A));
  assert.ok(debited > 9100 && debited < 9400, `~9,200 EUR cents (+fee) debited, got ${debited}`);
  assert.ok((await bal(USD_B)) > b0);
});

test('transfers: insufficient funds -> 409, fraud hold -> 422, ledger untouched', async () => {
  const a0 = await bal(USD_A);
  assert.equal((await post(EDGE, '/api/transfers', { from: USD_A, to: USD_B, amountCents: 99999999999 }, idem())).status, 409);
  assert.equal(await bal(USD_A), a0);
  const hot = 'acct-00020';
  for (let i = 0; i < 25; i++) await post(SVC.fraud, '/screen', { accountId: hot, amountCents: 600000 });
  const r = await post(EDGE, '/api/transfers', { from: hot, to: USD_B, amountCents: 600000 }, idem());
  assert.equal(r.status, 422); assert.match(r.json.error, /review/);
});

test('double-entry invariant: concurrent transfers conserve money exactly', async () => {
  const payers = ['acct-00030', 'acct-00031', 'acct-00032', 'acct-00033'].map((a) => a); // USD accounts
  const ids = [...payers, 'acct-02600', 'acct-02601', 'acct-fees'];
  const total = async () => (await Promise.all(ids.map(bal))).reduce((s, v) => s + v, 0);
  const before = await total();
  const results = await Promise.all(Array.from({ length: 60 }, (_, i) =>
    post(EDGE, '/api/transfers', { from: payers[i % 4], to: i % 2 ? 'acct-02600' : 'acct-02601', amountCents: 1000 + i, currency: 'USD' }, idem())));
  assert.ok(results.every((r) => r.status === 201), `statuses: ${results.map((r) => r.status).join(',')}`);
  assert.equal(await total(), before, 'sum of balances is unchanged: fees move to the treasury, nothing is created or lost');
});

// ---------------------------------------------------------------- statements + events
test('statements: per-account statement via the edge, 404 for unknown account', async () => {
  const r = await get(EDGE, `/api/statements/${USD_A}`);
  assert.equal(r.status, 200); assert.equal(r.json.accountId, USD_A);
  assert.ok(r.json.entries >= 1); assert.equal(r.json.creditsCents >= 0, true);
  assert.equal((await get(EDGE, '/api/statements/acct-99999')).status, 404);
});

test('events: transfer.completed is consumed by the statements worker', async () => {
  await post(EDGE, '/api/transfers', { from: USD_A, to: USD_B, amountCents: 1200, currency: 'USD' }, idem());
  const nc = await connect({ servers: NATS_URL });
  try {
    const jsm = await nc.jetstreamManager();
    await eventually(async () => { const ci = await jsm.consumers.info('TRANSFERS', 'statements'); return ci.delivered.stream_seq >= 1 && ci.num_pending === 0; }, { timeoutMs: 30000 });
  } finally { await nc.close(); }
});

// ---------------------------------------------------------------- edge
test('edge routes every public path and forwards the Idempotency-Key header', async () => {
  assert.equal((await get(EDGE, `/api/accounts/${USD_A}`)).status, 200);
  assert.equal((await get(EDGE, `/api/accounts/${USD_A}/risk-profile`)).status, 200);
  assert.equal((await get(EDGE, `/api/statements/${USD_A}`)).status, 200);
  const key = crypto.randomUUID();
  const body = { from: USD_A, to: USD_B, amountCents: 700, currency: 'USD' };
  const a = await post(EDGE, '/api/transfers', body, { 'idempotency-key': key });
  const b = await post(EDGE, '/api/transfers', body, { 'idempotency-key': key });
  assert.equal(b.json.transferId, a.json.transferId, 'header survives the proxy hop');
});

test('edge access log is in the shape the mapper parses (needs the docker CLI)', (t) => {
  let out;
  try { out = execFileSync('docker', ['logs', '--tail', '60', process.env.EDGE_CONTAINER ?? 'ledgerline-edge-1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { return t.skip('docker CLI / container not available'); }
  const rows = out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  assert.ok(rows.length > 0);
  for (const k of ['timestamp', 'method', 'uri', 'request', 'status', 'upstream_addr', 'upstream_response_time']) assert.ok(k in rows[0], `log has ${k}`);
  assert.match(rows.find((r) => r.upstream_addr && r.upstream_addr !== '-').upstream_addr, /^\d+\.\d+\.\d+\.\d+:\d+$/);
});
