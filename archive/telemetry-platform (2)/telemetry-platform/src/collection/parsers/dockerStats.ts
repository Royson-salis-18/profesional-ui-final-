import { parseByteSize, parseByteSizePair, parsePercent, parsePids } from "../units.js";

/**
 * Parses `docker stats --no-stream --no-trunc --format '{{json .}}'`
 * output — one JSON object per line, one line per running container.
 * Malformed lines are skipped and counted, never fatal (spec section 48).
 */
export interface DockerStatsEntry {
  containerId: string;
  name: string;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  memoryPercent: number | null;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
  blockReadBytes: number | null;
  blockWriteBytes: number | null;
  pids: number | null;
}

export interface DockerStatsParseResult {
  entries: DockerStatsEntry[];
  skippedLines: number;
}

interface RawDockerStatsLine {
  ID?: string;
  Container?: string;
  Name?: string;
  CPUPerc?: string;
  MemUsage?: string; // "50.5MiB / 1.952GiB"
  MemPerc?: string;
  NetIO?: string; // "1.4kB / 648B"
  BlockIO?: string; // "0B / 0B"
  PIDs?: string;
}

export function parseDockerStats(stdout: string): DockerStatsParseResult {
  const entries: DockerStatsEntry[] = [];
  let skippedLines = 0;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const raw = JSON.parse(trimmed) as RawDockerStatsLine;
      const containerId = raw.ID ?? raw.Container;
      if (!containerId) {
        skippedLines++;
        continue;
      }

      const [memUsageStr, memLimitStr] = (raw.MemUsage ?? "").split("/").map((s) => s.trim());
      const net = parseByteSizePair(raw.NetIO);
      const block = parseByteSizePair(raw.BlockIO);

      entries.push({
        containerId,
        name: raw.Name ?? "",
        cpuPercent: parsePercent(raw.CPUPerc),
        memoryBytes: parseByteSize(memUsageStr),
        memoryLimitBytes: parseByteSize(memLimitStr),
        memoryPercent: parsePercent(raw.MemPerc),
        networkRxBytes: net.rx,
        networkTxBytes: net.tx,
        blockReadBytes: block.rx,
        blockWriteBytes: block.tx,
        pids: parsePids(raw.PIDs),
      });
    } catch {
      skippedLines++;
    }
  }

  return { entries, skippedLines };
}

/** Parses the pipe-delimited output of REMOTE_COMMANDS.dockerInspectLite. */
export interface DockerInspectLiteResult {
  state: string | null;
  restartCount: number | null;
  startedAt: string | null;
}

export function parseDockerInspectLite(stdout: string): DockerInspectLiteResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("|");
  if (parts.length !== 3) return null;
  const [state, restartCountStr, startedAt] = parts;
  const restartCount = Number(restartCountStr);
  return {
    state: state || null,
    restartCount: Number.isInteger(restartCount) ? restartCount : null,
    startedAt: startedAt && startedAt !== "0001-01-01T00:00:00Z" ? startedAt : null,
  };
}
