// fraud-screening: scores a transfer or an account. Velocity counters live in the shared state-store.
import { envInt, env, envBool, log, createServer, HttpError, createRedis, onShutdown, call } from '../../lib/index.js';

const store = createRedis('STATE_STORE');
const ACCOUNTS = env('ACCOUNTS_URL', 'http://accounts:3101');
const FX = env('FX_URL', 'http://fx-rates:3105');
// "New accounts moving large sums" is the single most effective rule we have; it needs account age.
const ENRICH = envBool('FRAUD_ENRICH_FROM_ACCOUNTS', false);
const NORMALISE_TO_USD = envBool('FRAUD_NORMALISE_AMOUNTS', false);

async function score({ accountId, amountCents = 0, currency = 'USD' }) {
  let s = 0;
  let usd = amountCents;
  if (NORMALISE_TO_USD && currency !== 'USD') {
    const r = await call(FX, `/rates?from=${currency}&to=USD`, { timeoutMs: 800, retry: { max: 0, backoffMs: 0 } }).catch(() => null);
    if (r) usd = Math.round(amountCents * r.rate);
  }
  if (usd > 500000) s += 40; else if (usd > 100000) s += 15;
  const n = await store.incr(`velocity:${accountId}`);
  if (n === 1) await store.expire(`velocity:${accountId}`, 60);
  if (n > 20) s += 40; else if (n > 8) s += 15;
  if (ENRICH) {
    const a = await call(ACCOUNTS, `/accounts/${encodeURIComponent(accountId)}/summary`, { timeoutMs: envInt('ACCOUNTS_TIMEOUT_MS', 2500), retry: { max: 0, backoffMs: 0 } });
    if (a.age_days < 30 && usd > 50000) s += 30;
    if (a.status !== 'active') s += 50;
  }
  return Math.min(100, s);
}

const routes = [
  ['POST', '/screen', async ({ body }) => {
    if (!body?.accountId) throw new HttpError(400, 'accountId required');
    const s = await score(body);
    return { body: { score: s, decision: s >= 70 ? 'review' : 'allow' } };
  }],
  ['GET', '/assess', async ({ query }) => {
    if (!query.accountId) throw new HttpError(400, 'accountId required');
    return { body: { score: await score({ accountId: query.accountId }) } };
  }],
];
await store.connect();
const server = createServer({ port: envInt('PORT', 3104), routes, ready: async () => (await store.ping()) === 'PONG' });
await server.listen();
onShutdown(async () => { await server.drain(); store.disconnect(); });
