/**
 * CPU usage from cumulative counters (spec section 11).
 *
 * NOTE ON WHEN THIS IS ACTUALLY USED: this collector talks to targets over
 * SSH + Docker CLI, not the Docker Engine API/socket. `docker stats` over
 * CLI only exposes an already-computed CPU percentage, not the raw
 * cumulative `cpu_usage.total_usage` / `system_cpu_usage` counters the
 * Docker API exposes. So today's default path (dockerStats.ts) uses
 * Docker's own pre-computed CPUPerc directly. This module exists so that
 * (a) the exact delta math the spec describes is implemented and unit
 * tested independently of the collection path, and (b) a future Docker
 * API/socket-based collector can reuse it verbatim by feeding in raw
 * counters instead of parsing percentages.
 */

export interface CpuCounterSample {
  totalUsageNs: number;
  systemUsageNs: number;
  onlineCpus: number;
}

/**
 * cpuPercent = (cpuDelta / systemDelta) * onlineCpus * 100
 *
 * Returns null (never NaN/Infinity/a fabricated 0) when:
 *  - there is no previous sample (first sample — nothing to diff against)
 *  - systemDelta <= 0 (no time actually elapsed on the system counter)
 *  - cpuDelta < 0 (counter reset, e.g. container restarted)
 */
export function computeCpuPercentFromDelta(
  current: CpuCounterSample,
  previous: CpuCounterSample | null,
): number | null {
  if (previous === null) return null;

  const cpuDelta = current.totalUsageNs - previous.totalUsageNs;
  const systemDelta = current.systemUsageNs - previous.systemUsageNs;

  if (systemDelta <= 0) return null; // no elapsed system time, or clock/counter anomaly
  if (cpuDelta < 0) return null; // counter reset (e.g. restart) — do not compute a negative %
  if (current.onlineCpus <= 0) return null;

  const percent = (cpuDelta / systemDelta) * current.onlineCpus * 100;

  if (!Number.isFinite(percent) || Number.isNaN(percent)) return null;
  return percent;
}

/**
 * Stateful helper: tracks the last sample per key (e.g. serviceId) and
 * returns the computed percent, or null on the first sample for that key.
 */
export class CpuDeltaTracker {
  private lastSample = new Map<string, CpuCounterSample>();

  sample(key: string, current: CpuCounterSample): number | null {
    const previous = this.lastSample.get(key) ?? null;
    const percent = computeCpuPercentFromDelta(current, previous);
    this.lastSample.set(key, current);
    return percent;
  }

  reset(key: string): void {
    this.lastSample.delete(key);
  }
}
