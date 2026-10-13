// statements-worker: periodic statement runs over accounts touched since the last run, plus an on-demand API.
// Reads the ledger database directly with a read-only role (standard for reporting workloads).
import { envInt, env, log, createServer, HttpError, createPool, pingPool, waitFor, onShutdown, call, connectBus, ensureStream, consume, setGauge } from '../../lib/index.js';

const db = createPool('STATEMENTS_DB', { database: 'ledger', defaults: { max: 5 } });
const ACCOUNTS = env('ACCOUNTS_URL', 'http://accounts:3101');
const touched = new Set();

// Loads one account's entries for the period and summarises them. Statement generation is per account.
async function statement(accountId) {
  const { rows } = await db.query('select id, txn_id, amount_cents, currency, created_at from entries where account_id=$1 order by id', [accountId]);
  let credits = 0, debits = 0;
  for (const r of rows) (r.amount_cents >= 0 ? (credits += r.amount_cents) : (debits += -r.amount_cents));
  return { accountId, entries: rows.length, creditsCents: credits, debitsCents: debits };
}

async function runBatch() {
  const ids = [...touched]; touched.clear();
  if (!ids.length) { // after a restart the in-memory set is empty: fall back to the ledger itself
    const { rows } = await db.query("select distinct account_id from entries where created_at > now() - interval '1 hour' limit $1", [envInt('STATEMENT_FALLBACK_ACCOUNTS', 200)]);
    ids.push(...rows.map((r) => r.account_id));
  }
  // The treasury account gets a statement every run (finance reconciles it daily).
  for (const id of env('STATEMENT_ALWAYS_INCLUDE', 'acct-fees').split(',').filter(Boolean)) if (!ids.includes(id)) ids.push(id);
  const t0 = Date.now(); let n = 0;
  const workers = Math.max(1, envInt('STATEMENT_CONCURRENCY', 4));
  const queue = [...ids];
  await Promise.all(Array.from({ length: workers }, async () => { for (let id; (id = queue.shift()) !== undefined;) { await statement(id); n++; } }));
  log.info('statement run finished', { accounts: n, ms: Date.now() - t0 });
}

const routes = [
  ['GET', '/statements/:accountId', async ({ params }) => {
    await call(ACCOUNTS, `/accounts/${encodeURIComponent(params.accountId)}`, { timeoutMs: 1500 }).catch((e) => { throw e.status === 404 ? new HttpError(404, 'unknown account') : new HttpError(502, 'accounts unavailable'); });
    return { body: await statement(params.accountId) };
  }],
];

await waitFor('ledger-db', () => pingPool(db), { retries: envInt('DB_CONNECT_RETRIES', 30), delayMs: 1000 });
const bus = await waitFor('event-bus', async () => { const b = await connectBus(); await ensureStream(b, 'TRANSFERS', ['transfer.*']); return b; }, { retries: envInt('BUS_CONNECT_RETRIES', 30), delayMs: 1000 });
await consume(bus, { stream: 'TRANSFERS', durable: 'statements', filter: 'transfer.completed', prefix: 'STATEMENTS', handler: async (e) => { touched.add(e.from); touched.add(e.to); } });
let running = false;
const tick = async () => { if (running) return; running = true; try { await runBatch(); } catch (e) { log.error('statement run failed', { err: e.message }); } finally { running = false; } };
setTimeout(() => { tick(); setInterval(tick, envInt('STATEMENT_BATCH_INTERVAL_S', 60) * 1000).unref(); }, envInt('STATEMENT_FIRST_RUN_DELAY_S', 20) * 1000).unref();
setInterval(() => setGauge('statement_touched_accounts', 'Accounts waiting for the next run', touched.size), 5000).unref();
const server = createServer({ port: envInt('PORT', 3106), routes, ready: async () => (await pingPool(db), true) });
await server.listen();
onShutdown(async () => { await server.drain(); await bus.nc.drain(); await db.end(); });
