import type { Connection } from "../connection/Connection.js";
import { REMOTE_COMMANDS } from "../connection/RemoteCommand.js";
import { parseDockerStats, parseDockerInspectLite } from "./parsers/dockerStats.js";
import type { ContainerMetricSample } from "../types/metrics.js";
import type { Service } from "../types/service.js";

export interface MetricCollectionResult {
  samples: ContainerMetricSample[];
  warnings: string[];
}

/** Per-service state needed to derive rates across polls. */
interface PreviousSample {
  timestamp: string;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
  restartCount: number | null;
}

/**
 * Collects one round of container-level telemetry. Network/restart rates
 * are only derived once a second, later sample exists for that service —
 * the first poll after start always has `null` rates, never a guessed 0
 * (spec section 13, section 32).
 */
export class MetricCollector {
  private previous = new Map<string, PreviousSample>();

  constructor(
    private readonly targetId: string,
    private readonly connection: Connection,
  ) {}

  /**
   * @param services Known services (from discovery), used to map a
   *   containerId -> stable serviceId. A container running that isn't in
   *   this list still produces a sample, but with serviceId derived
   *   ad-hoc, and a warning is recorded (spec section 48: don't drop
   *   evidence just because it's unexpected).
   */
  async collectOnce(services: Service[]): Promise<MetricCollectionResult> {
    const warnings: string[] = [];
    const now = new Date().toISOString();

    const byContainerId = new Map(
      services.filter((s) => s.containerId).map((s) => [s.containerId as string, s]),
    );

    const statsRes = await this.connection.execute(REMOTE_COMMANDS.dockerStats());
    if (statsRes.error || statsRes.exitCode !== 0) {
      warnings.push(`docker stats failed: ${statsRes.error ?? statsRes.stderr}`);
      return { samples: [], warnings };
    }

    const { entries, skippedLines } = parseDockerStats(statsRes.stdout);
    if (skippedLines > 0) {
      warnings.push(`Skipped ${skippedLines} unparseable docker stats line(s)`);
    }

    const samples: ContainerMetricSample[] = [];

    for (const entry of entries) {
      const service = byContainerId.get(entry.containerId);
      const serviceId = service?.serviceId ?? `${this.targetId}:unknown-${entry.containerId.slice(0, 12)}`;
      if (!service) {
        warnings.push(
          `Container ${entry.containerId} (${entry.name}) has no matching discovered service — using ad-hoc serviceId`,
        );
      }

      const liteRes = await this.connection.execute(
        REMOTE_COMMANDS.dockerInspectLite(entry.containerId),
      );
      const lite =
        liteRes.exitCode === 0 && !liteRes.error ? parseDockerInspectLite(liteRes.stdout) : null;
      if (!lite) {
        warnings.push(`docker inspect (lite) failed for container ${entry.containerId}`);
      }

      const prev = this.previous.get(serviceId) ?? null;
      const { rxRate, txRate } = computeRates(now, prev, entry.networkRxBytes, entry.networkTxBytes);
      const restartDelta = computeRestartDelta(prev, lite?.restartCount ?? null);
      const uptimeSeconds = computeUptimeSeconds(lite?.state ?? null, lite?.startedAt ?? null, now);

      samples.push({
        timestamp: now,
        collectorReceivedAt: now,
        targetId: this.targetId,
        serviceId,
        containerId: entry.containerId,

        cpuPercent: entry.cpuPercent,
        cpuRaw: null, // not available over CLI — see collection/cpu.ts header note

        memoryBytes: entry.memoryBytes,
        memoryLimitBytes: entry.memoryLimitBytes,
        memoryPercent: entry.memoryPercent,

        networkRxBytes: entry.networkRxBytes,
        networkTxBytes: entry.networkTxBytes,
        networkRxBytesPerSecond: rxRate,
        networkTxBytesPerSecond: txRate,

        pids: entry.pids,
        blockReadBytes: entry.blockReadBytes,
        blockWriteBytes: entry.blockWriteBytes,

        restartCount: lite?.restartCount ?? null,
        restartDelta,

        containerState: lite?.state ?? null,
        containerUptimeSeconds: uptimeSeconds,

        valid: true,
      });

      this.previous.set(serviceId, {
        timestamp: now,
        networkRxBytes: entry.networkRxBytes,
        networkTxBytes: entry.networkTxBytes,
        restartCount: lite?.restartCount ?? null,
      });
    }

    return { samples, warnings };
  }
}

function computeRates(
  nowIso: string,
  prev: PreviousSample | null,
  currentRx: number | null,
  currentTx: number | null,
): { rxRate: number | null; txRate: number | null } {
  if (!prev || currentRx === null || currentTx === null) {
    return { rxRate: null, txRate: null };
  }
  if (prev.networkRxBytes === null || prev.networkTxBytes === null) {
    return { rxRate: null, txRate: null };
  }

  const elapsedSeconds = (Date.parse(nowIso) - Date.parse(prev.timestamp)) / 1000;
  if (elapsedSeconds <= 0) return { rxRate: null, txRate: null };

  const rxDelta = currentRx - prev.networkRxBytes;
  const txDelta = currentTx - prev.networkTxBytes;
  return {
    rxRate: rxDelta >= 0 ? rxDelta / elapsedSeconds : null,
    txRate: txDelta >= 0 ? txDelta / elapsedSeconds : null,
  };
}

function computeRestartDelta(
  prev: PreviousSample | null,
  currentRestartCount: number | null,
): number | null {
  if (!prev || currentRestartCount === null || prev.restartCount === null) return null;
  const delta = currentRestartCount - prev.restartCount;
  return delta >= 0 ? delta : null;
}

function computeUptimeSeconds(
  state: string | null,
  startedAt: string | null,
  nowIso: string,
): number | null {
  if (state !== "running" || !startedAt) return null;
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return null;
  const uptimeMs = Date.parse(nowIso) - startedMs;
  return uptimeMs >= 0 ? uptimeMs / 1000 : null;
}
