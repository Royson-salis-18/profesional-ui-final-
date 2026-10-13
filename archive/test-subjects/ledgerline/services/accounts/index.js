// accounts: customer accounts and profiles. Owns accounts-db.
import { envInt, env, envBool, log, createServer, HttpError, createPool, pingPool, waitFor, onShutdown, call } from '../../lib/index.js';

const db = createPool('ACCOUNTS_DB', { database: 'accounts' });
const FRAUD = env('FRAUD_URL', 'http://fraud-screening:3104');

const routes = [
  ['GET', '/accounts/:id', async ({ params }) => {
    const { rows } = await db.query('select id, owner, status, currency, kyc_level from accounts where id=$1', [params.id]);
    if (!rows[0]) throw new HttpError(404, 'account not found');
    return { body: rows[0] };
  }],
  // Used by other services that need account age/standing without the full profile.
  ['GET', '/accounts/:id/summary', async ({ params }) => {
    const { rows } = await db.query("select id, status, kyc_level, extract(day from now()-created_at)::int as age_days from accounts where id=$1", [params.id]);
    if (!rows[0]) throw new HttpError(404, 'account not found');
    return { body: rows[0] };
  }],
  // Profile page: account details plus a risk badge. The row is locked FOR SHARE while the risk
  // assessment runs so the profile shown is consistent with the score computed (a snapshot read).
  ['GET', '/accounts/:id/risk-profile', async ({ params }) => {
    const c = await db.connect();
    try {
      await c.query('begin');
      const { rows } = await c.query('select id, owner, status, currency, kyc_level from accounts where id=$1 for share', [params.id]);
      if (!rows[0]) throw new HttpError(404, 'account not found');
      const risk = await call(FRAUD, `/assess?accountId=${encodeURIComponent(params.id)}`, { timeoutMs: envInt('FRAUD_TIMEOUT_MS', 3000), retry: { max: 0, backoffMs: 0 } })
        .catch((e) => { log.warn('risk assessment unavailable', { err: e.message }); return { score: null }; });
      await c.query('commit');
      return { body: { ...rows[0], risk } };
    } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
  }],
];

await waitFor('accounts-db', () => pingPool(db), { retries: envInt('DB_CONNECT_RETRIES', 30), delayMs: 1000 });
const server = createServer({ port: envInt('PORT', 3101), routes, ready: async () => (await pingPool(db), true) });
await server.listen();
onShutdown(async () => { await server.drain(); await db.end(); });
