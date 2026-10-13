// fx-rates: internal rates API in front of the vendor, with a short cache and a circuit breaker.
import { envInt, env, log, createServer, HttpError, onShutdown, call, setGauge } from '../../lib/index.js';

const PROVIDER = env('FX_PROVIDER_URL', 'http://fx-provider:4100');
const CACHE_MS = envInt('FX_CACHE_TTL_MS', 5000);
const STALE_OK_MS = envInt('FX_STALE_IF_ERROR_MS', 0); // 0 = never serve a stale rate
const BR = { failures: envInt('FX_BREAKER_FAILURES', 5), openMs: envInt('FX_BREAKER_OPEN_MS', 15000) };
const cache = new Map();
const breaker = { fails: 0, openUntil: 0 };

async function rate(from, to) {
  if (from === to) return { rate: 1, asOf: new Date().toISOString(), source: 'identity' };
  const key = `${from}:${to}`, hit = cache.get(key), now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return { ...hit.v, source: 'cache' };
  if (now < breaker.openUntil) {
    if (hit && STALE_OK_MS && now - hit.at < STALE_OK_MS) return { ...hit.v, source: 'stale' };
    throw new HttpError(503, 'fx provider unavailable (circuit open)');
  }
  try {
    const v = await call(PROVIDER, `/v1/rate?from=${from}&to=${to}`, { timeoutMs: envInt('FX_PROVIDER_TIMEOUT_MS', 1500), retry: { max: 1, backoffMs: 100 } });
    breaker.fails = 0;
    cache.set(key, { at: now, v });
    return { ...v, source: 'provider' };
  } catch (e) {
    if (++breaker.fails >= BR.failures) { breaker.openUntil = Date.now() + BR.openMs; breaker.fails = 0; log.warn('circuit opened', { forMs: BR.openMs }); }
    if (hit && STALE_OK_MS && now - hit.at < STALE_OK_MS) return { ...hit.v, source: 'stale' };
    throw new HttpError(503, 'fx provider unavailable');
  }
}
setInterval(() => setGauge('fx_circuit_open', '1 when the provider circuit is open', Date.now() < breaker.openUntil ? 1 : 0), 1000).unref();

const routes = [['GET', '/rates', async ({ query }) => {
  if (!query.from || !query.to) throw new HttpError(400, 'from and to required');
  return { body: await rate(query.from, query.to) };
}]];
const server = createServer({ port: envInt('PORT', 3105), routes });
await server.listen();
onShutdown(() => server.drain());
