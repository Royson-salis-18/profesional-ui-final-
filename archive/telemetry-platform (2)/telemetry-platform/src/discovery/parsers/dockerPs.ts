/**
 * Parses `docker ps --no-trunc --format '{{json .}}'` output, which is
 * one JSON object per line (NOT a JSON array). Malformed lines are
 * skipped, not fatal — one bad line must not lose every other container
 * (spec section 48).
 */

export interface DockerPsEntry {
  ID: string;
  Image: string;
  Command?: string;
  CreatedAt?: string;
  Status?: string;
  Ports?: string;
  Names: string;
  Labels?: string;
  State?: string;
  RunningFor?: string;
}

export interface DockerPsParseResult {
  entries: DockerPsEntry[];
  skippedLines: number;
}

export function parseDockerPs(stdout: string): DockerPsParseResult {
  const entries: DockerPsEntry[] = [];
  let skippedLines = 0;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<DockerPsEntry>;
      if (!parsed.ID || !parsed.Names || !parsed.Image) {
        skippedLines++;
        continue;
      }
      entries.push(parsed as DockerPsEntry);
    } catch {
      skippedLines++;
    }
  }

  return { entries, skippedLines };
}

/** `docker ps` Labels field is a comma-separated `key=value` string. */
export function parseLabelsString(labels: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!labels) return result;
  for (const pair of labels.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/** `docker ps` Ports field looks like: "0.0.0.0:80->8080/tcp, 8080/tcp" */
export function parsePortsString(
  ports: string | undefined,
): { containerPort: number; hostPort?: number; protocol: "tcp" | "udp" }[] {
  if (!ports) return [];
  const result: { containerPort: number; hostPort?: number; protocol: "tcp" | "udp" }[] = [];
  for (const raw of ports.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    // e.g. "0.0.0.0:80->8080/tcp" or "8080/tcp"
    const match = part.match(/(?:[\d.]+:(\d+)->)?(\d+)\/(tcp|udp)/);
    if (!match) continue;
    const [, hostPortStr, containerPortStr, protocol] = match;
    result.push({
      containerPort: Number(containerPortStr),
      hostPort: hostPortStr ? Number(hostPortStr) : undefined,
      protocol: protocol as "tcp" | "udp",
    });
  }
  return result;
}
