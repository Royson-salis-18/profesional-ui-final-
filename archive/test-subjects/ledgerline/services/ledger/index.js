// ledger: the double-entry book. Every transfer is two entries that sum to zero, written atomically.
import { envInt, env, log, createServer, HttpError, createPool, pingPool, poolStats, waitFor, onShutdown, setGauge } from '../../lib/index.js';

const db = createPool('LEDGER_DB', { database: 'ledger', defaults: { max: 20 } });
// deferred: fee entries are appended (insert-only) and summed by the nightly close.
// inline:   the fee account's balance row is updated in the same transaction (always-current fee balance).
const FEE_POSTING = env('FEE_POSTING', 'deferred');
const FEE_BPS = envInt('FEE_BPS', 10);
const FEES = 'acct-fees';

const routes = [
  ['POST', '/entries', async ({ body }) => {
    const { txnId, from, to, amountCents, currency = 'USD' } = body ?? {};
    if (!txnId || !from || !to || !(amountCents > 0)) throw new HttpError(400, 'txnId, from, to, amountCents required');
    const fee = Math.floor((amountCents * FEE_BPS) / 10000);
    const c = await db.connect();
    try {
      await c.query('begin');
      const dup = await c.query('select 1 from entries where txn_id=$1 limit 1', [txnId]);
      if (dup.rowCount) { await c.query('commit'); return { body: { posted: true, duplicate: true } }; }
      const lockIds = [from, to, ...(FEE_POSTING === 'inline' ? [FEES] : [])].sort(); // consistent order: no deadlocks
      for (const id of lockIds) await c.query('select 1 from balances where account_id=$1 for update', [id]);
      const dr = await c.query('update balances set balance_cents=balance_cents-($2::bigint+$3::bigint) where account_id=$1 and balance_cents >= $2::bigint + $3::bigint returning balance_cents', [from, amountCents, fee]);
      if (!dr.rowCount) throw new HttpError(409, 'insufficient funds');
      await c.query('update balances set balance_cents=balance_cents+$2 where account_id=$1', [to, amountCents]);
      if (FEE_POSTING === 'inline') await c.query('update balances set balance_cents=balance_cents+$1 where account_id=$2', [fee, FEES]);
      await c.query('insert into entries(txn_id, account_id, amount_cents, currency) values ($1,$2,$3,$7),($1,$4,$5,$7),($1,$6,$8,$7)',
        [txnId, from, -(amountCents + fee), to, amountCents, FEES, currency, fee]);
      await c.query('commit');
      return { status: 201, body: { posted: true, feeCents: fee, balanceCents: dr.rows[0].balance_cents } };
    } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
  }],
  ['GET', '/balances/:id', async ({ params }) => {
    const { rows } = await db.query('select balance_cents from balances where account_id=$1', [params.id]);
    if (!rows[0]) throw new HttpError(404, 'unknown account');
    let balance = rows[0].balance_cents;
    if (params.id === FEES && FEE_POSTING === 'deferred') {
      // deferred mode: the treasury row only moves at the nightly close; fees since then are pending entries
      const p = await db.query('select coalesce(sum(amount_cents),0) as pending from entries where account_id=$1 and id > (select last_entry_id from fee_rollup)', [FEES]);
      balance += p.rows[0].pending;
    }
    return { body: { accountId: params.id, balanceCents: balance } };
  }],
];

await waitFor('ledger-db', () => pingPool(db), { retries: envInt('DB_CONNECT_RETRIES', 30), delayMs: 1000 });
setInterval(() => { const s = poolStats(db); setGauge('db_pool_waiting', 'Queries waiting for a pooled connection', s.waiting); setGauge('db_pool_total', 'Open pooled connections', s.total); }, 2000).unref();
const server = createServer({ port: envInt('PORT', 3103), routes, ready: async () => (await pingPool(db), true) });
await server.listen();
onShutdown(async () => { await server.drain(); await db.end(); });
