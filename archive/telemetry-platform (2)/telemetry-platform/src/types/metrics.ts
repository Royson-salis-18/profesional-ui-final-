/**
 * Resource telemetry model.
 *
 * Rule: missing != zero. Use `null` for values that were not observed,
 * never silently coerce a collection failure to 0.
 */

export interface RawCpuSample {
  /** Cumulative CPU time in nanoseconds, as reported by the source (e.g. docker stats). */
  totalUsageNs: number | null;
  systemUsageNs: number | null;
  onlineCpus: number | null;
}

export interface ContainerMetricSample {
  timestamp: string; // ISO-8601 UTC — event time
  collectorReceivedAt: string; // ISO-8601 UTC — when the collector observed it
  targetId: string;
  serviceId: string;
  containerId?: string;

  // CPU
  cpuPercent: number | null; // derived from deltas, see cpu.ts
  cpuRaw: RawCpuSample | null;

  // Memory (raw bytes only — never store only human formatted strings)
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  memoryPercent: number | null;

  // Network — cumulative counters as reported
  networkRxBytes: number | null;
  networkTxBytes: number | null;
  // Derived rates — only computed when 2+ time-separated samples exist
  networkRxBytesPerSecond: number | null;
  networkTxBytesPerSecond: number | null;

  // PIDs / block IO, when supported by the source
  pids: number | null;
  blockReadBytes: number | null;
  blockWriteBytes: number | null;

  restartCount: number | null;
  restartDelta: number | null;

  containerState: string | null;
  containerUptimeSeconds: number | null;

  /** Data quality flags */
  valid: boolean;
  validationReason?: string;
}
