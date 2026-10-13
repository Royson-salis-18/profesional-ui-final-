// fx-provider: stand-in for a third-party FX rate vendor. Not ours; its availability is not under our control.
import { envInt, env, createServer, HttpError, onShutdown } from '../../lib/index.js';
const MODE = env('FX_PROVIDER_MODE', 'ok'); // ok | down | slow
const RATES = { 'USD:EUR': 0.92, 'EUR:USD': 1.087, 'USD:GBP': 0.79, 'GBP:USD': 1.266, 'EUR:GBP': 0.86, 'GBP:EUR': 1.163 };
const routes = [['GET', '/v1/rate', async ({ query }) => {
  if (MODE === 'down') throw new HttpError(503, 'provider unavailable');
  if (MODE === 'slow') await new Promise((r) => setTimeout(r, envInt('FX_SLOW_MS', 4000)));
  const r = RATES[`${query.from}:${query.to}`];
  if (!r) throw new HttpError(404, 'unknown pair');
  return { body: { rate: r * (1 + (Math.random() - 0.5) * 0.002), asOf: new Date().toISOString() } };
}]];
const server = createServer({ port: envInt('PORT', 4100), routes });
await server.listen();
onShutdown(() => server.drain());
