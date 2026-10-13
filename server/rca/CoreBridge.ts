/**
 * The bridge to the Python core (core/service.py, port 8000).
 *
 * The core holds the algorithms that were measured (root cause ranked first in 69.5% of 751 labelled faults, 0.15 false alarms an
 * hour); this server stays the data collector and graph builder. The UI asks THIS server for incidents, and this server prefers the
 * core's answer. If the core is not running, or has not collected enough history for a target yet, the older rule-based incidents
 * (IncidentManager) are used instead, so the UI never goes blank.
 */
const CORE_URL = process.env.CORE_URL ?? 'http://127.0.0.1:8000';
const TIMEOUT_MS = 1500;

export interface CoreAnalysis {
  ready: Record<string, boolean>;
  incidents: any[];
}

async function getJson(path: string): Promise<any | null> {
  try {
    const res = await fetch(`${CORE_URL}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;                       // core not running: not an error, the caller falls back
  }
}

/** The core's incidents and which targets it can already judge. null when the core is unreachable. */
export async function coreAnalysis(): Promise<CoreAnalysis | null> {
  const a = await getJson('/api/core/analysis');
  return a && Array.isArray(a.incidents) && a.ready ? (a as CoreAnalysis) : null;
}

/** Plain pass-through of a GET to the core, for the UI's evaluation views. Returns [status, body]. */
export async function coreProxy(path: string): Promise<[number, any]> {
  try {
    const res = await fetch(`${CORE_URL}/api/core${path}`, { signal: AbortSignal.timeout(30_000) });
    return [res.status, await res.json()];
  } catch {
    return [503, { error: `The analysis core is not running (expected at ${CORE_URL}). Start it with: python -m core` }];
  }
}
