// Tiny HTTP helper + service map for the API tests. Override hosts/ports with env if you run elsewhere.
export const EDGE = process.env.EDGE_URL ?? 'http://localhost:8081';
export const SVC = {
  accounts: process.env.ACCOUNTS_URL ?? 'http://localhost:3101',
  transfers: process.env.TRANSFERS_URL ?? 'http://localhost:3102',
  ledger: process.env.LEDGER_URL ?? 'http://localhost:3103',
  fraud: process.env.FRAUD_URL ?? 'http://localhost:3104',
  fx: process.env.FX_URL ?? 'http://localhost:3105',
  fxProvider: process.env.FX_PROVIDER_URL ?? 'http://localhost:4100',
  statements: process.env.STATEMENTS_URL ?? 'http://localhost:3106',
};
export const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4223';

export async function req(base, method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, json, headers: res.headers, text };
}
export const get = (b, p, h) => req(b, 'GET', p, undefined, h);
export const post = (b, p, body, h) => req(b, 'POST', p, body, h);
export const del = (b, p) => req(b, 'DELETE', p);
export const uid = (p = 'u') => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
export async function eventually(fn, { timeoutMs = 20000, everyMs = 500 } = {}) {
  const end = Date.now() + timeoutMs; let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await new Promise((r) => setTimeout(r, everyMs)); }
  throw new Error(`condition not met in ${timeoutMs}ms (last: ${last?.message ?? JSON.stringify(last)})`);
}
