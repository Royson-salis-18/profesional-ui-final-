// transfers: the orchestrator. Validates, screens, converts, posts to the ledger, announces completion.
import crypto from 'node:crypto';
import { envInt, env, log, createServer, HttpError, createRedis, waitFor, onShutdown, call, retryFromEnv, connectBus, ensureStream, publish } from '../../lib/index.js';

const store = createRedis('STATE_STORE');
const U = { accounts: env('ACCOUNTS_URL', 'http://accounts:3101'), fraud: env('FRAUD_URL', 'http://fraud-screening:3104'), fx: env('FX_URL', 'http://fx-rates:3105'), ledger: env('LEDGER_URL', 'http://ledger:3103') };
const T = { accounts: envInt('ACCOUNTS_TIMEOUT_MS', 1500), fraud: envInt('FRAUD_TIMEOUT_MS', 1500), fx: envInt('FX_TIMEOUT_MS', 2500), ledger: envInt('LEDGER_TIMEOUT_MS', 5000) };
const ledgerRetry = retryFromEnv('LEDGER', { max: 1, backoffMs: 200 });
let bus;

const routes = [
  ['POST', '/transfers', async ({ req, body }) => {
    const idem = req.headers['idempotency-key'];
    if (!idem) throw new HttpError(400, 'Idempotency-Key header required');
    const { from, to, amountCents, currency = 'USD' } = body ?? {};
    if (!from || !to || from === to || !(amountCents > 0)) throw new HttpError(400, 'from, to (different), amountCents>0 required');

    const prior = await store.get(`idem:${idem}`);
    if (prior) return { status: 200, body: { ...JSON.parse(prior), replayed: true } };

    const [src, dst] = await Promise.all([
      call(U.accounts, `/accounts/${encodeURIComponent(from)}`, { timeoutMs: T.accounts }),
      call(U.accounts, `/accounts/${encodeURIComponent(to)}`, { timeoutMs: T.accounts }),
    ]).catch((e) => { throw e.status === 404 ? new HttpError(404, 'unknown account') : new HttpError(502, 'accounts unavailable'); });
    if (src.status !== 'active' || dst.status !== 'active') throw new HttpError(422, 'account not active');

    const screen = await call(U.fraud, '/screen', { method: 'POST', body: { accountId: from, amountCents, currency }, timeoutMs: T.fraud })
      .catch(() => { throw new HttpError(503, 'fraud screening unavailable'); });
    if (screen.decision === 'review') throw new HttpError(422, 'held for review');

    let rate = 1;
    if (currency !== src.currency) {
      rate = (await call(U.fx, `/rates?from=${currency}&to=${src.currency}`, { timeoutMs: T.fx }).catch(() => { throw new HttpError(503, 'fx rates unavailable'); })).rate;
    }
    const txnId = crypto.randomUUID();
    const post = await call(U.ledger, '/entries', { method: 'POST', body: { txnId, from, to, amountCents: Math.round(amountCents * rate), currency: src.currency }, timeoutMs: T.ledger, retry: ledgerRetry })
      .catch((e) => { throw e.status === 409 ? new HttpError(409, 'insufficient funds') : new HttpError(502, 'ledger unavailable'); });
    const out = { transferId: txnId, status: 'completed', feeCents: post.feeCents };
    await store.set(`idem:${idem}`, JSON.stringify(out), 'EX', 86400);
    publish(bus, 'transfer.completed', { transferId: txnId, from, to, amountCents }).catch((e) => log.error('event publish failed', { err: e.message }));
    return { status: 201, body: out };
  }],
];
await store.connect();
bus = await waitFor('event-bus', async () => { const b = await connectBus(); await ensureStream(b, 'TRANSFERS', ['transfer.*']); return b; }, { retries: envInt('BUS_CONNECT_RETRIES', 30), delayMs: 1000 });
const server = createServer({ port: envInt('PORT', 3102), routes, ready: async () => (await store.ping()) === 'PONG' });
await server.listen();
onShutdown(async () => { await server.drain(); await bus.nc.drain(); store.disconnect(); });
