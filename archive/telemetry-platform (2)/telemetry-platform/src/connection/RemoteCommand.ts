/**
 * Every remote command run against a target must go through this
 * abstraction. No arbitrary shell strings from user input are executed
 * without being wrapped as a named, bounded, auditable RemoteCommand.
 */

export interface RemoteCommandResult<T = unknown> {
  name: string;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  parsed?: T;
  error?: string;
}

export interface RemoteCommand<T = unknown> {
  /** Human-readable, logged name — e.g. "docker.ps" */
  name: string;
  /** The literal command to execute. No string interpolation of raw user input. */
  command: string;
  /** Hard timeout in ms. Command is killed if it exceeds this. */
  timeoutMs: number;
  /** Max bytes of stdout/stderr retained (protects against unbounded output). */
  maxOutputBytes: number;
  /** Structured parser turning raw stdout into a typed result. */
  parser?: (stdout: string) => T;
}

/** Registry of known-safe, pre-defined commands (spec section 5 & 6). */
export const REMOTE_COMMANDS = {
  unameAll: (): RemoteCommand<string> => ({
    name: "uname.all",
    command: "uname -a",
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
    parser: (out) => out.trim(),
  }),
  hostname: (): RemoteCommand<string> => ({
    name: "hostname",
    command: "hostname",
    timeoutMs: 5_000,
    maxOutputBytes: 1_024,
    parser: (out) => out.trim(),
  }),
  dateUtc: (): RemoteCommand<string> => ({
    name: "date.utc",
    command: "date -u +%Y-%m-%dT%H:%M:%S.%3NZ",
    timeoutMs: 5_000,
    maxOutputBytes: 256,
    parser: (out) => out.trim(),
  }),
  dockerVersion: (): RemoteCommand<string> => ({
    name: "docker.version",
    command: "docker version --format '{{json .}}' 2>&1",
    timeoutMs: 8_000,
    maxOutputBytes: 16_384,
  }),
  dockerPs: (): RemoteCommand<string> => ({
    name: "docker.ps",
    command: "docker ps --no-trunc --format '{{json .}}'",
    timeoutMs: 10_000,
    maxOutputBytes: 262_144,
  }),
  dockerInspect: (containerId: string): RemoteCommand<string> => ({
    name: "docker.inspect",
    command: `docker inspect ${sanitizeContainerId(containerId)}`,
    timeoutMs: 10_000,
    maxOutputBytes: 262_144,
  }),
  dockerStats: (): RemoteCommand<string> => ({
    name: "docker.stats",
    command:
      "docker stats --no-stream --no-trunc --format '{{json .}}'",
    timeoutMs: 15_000,
    maxOutputBytes: 262_144,
  }),
  dockerNetworkInspect: (network: string): RemoteCommand<string> => ({
    name: "docker.network.inspect",
    command: `docker network inspect ${sanitizeContainerId(network)}`,
    timeoutMs: 10_000,
    maxOutputBytes: 262_144,
  }),
  dockerLogs: (
    containerId: string,
    sinceIso: string,
    tailLines: number,
  ): RemoteCommand<string> => ({
    name: "docker.logs",
    command: `docker logs --timestamps --since ${sanitizeIso(
      sinceIso,
    )} --tail ${sanitizeTail(tailLines)} ${sanitizeContainerId(containerId)}`,
    timeoutMs: 15_000,
    maxOutputBytes: 5_000_000,
  }),
  ssLtnp: (): RemoteCommand<string> => ({
    name: "ss.ltnp",
    command: "ss -ltnp 2>&1",
    timeoutMs: 8_000,
    maxOutputBytes: 65_536,
  }),
  dockerInspectLite: (containerId: string): RemoteCommand<string> => ({
    name: "docker.inspect.lite",
    command: `docker inspect --format '{{.State.Status}}|{{.RestartCount}}|{{.State.StartedAt}}' ${sanitizeContainerId(
      containerId,
    )}`,
    timeoutMs: 8_000,
    maxOutputBytes: 1_024,
  }),
  catFile: (path: string): RemoteCommand<string> => ({
    name: "cat.file",
    command: `cat ${sanitizePath(path)} 2>&1`,
    timeoutMs: 5_000,
    maxOutputBytes: 1_000_000,
  }),
} as const;

// --- Minimal sanitizers: only allow the identifier shapes Docker itself
// produces (container IDs, names, network names). Reject anything else. ---

function sanitizeContainerId(id: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(id)) {
    throw new Error(`Refusing to build command: unsafe identifier "${id}"`);
  }
  return id;
}

function sanitizeIso(iso: string): string {
  if (Number.isNaN(Date.parse(iso))) {
    throw new Error(`Refusing to build command: invalid ISO timestamp "${iso}"`);
  }
  return iso;
}

function sanitizePath(path: string): string {
  // Absolute paths only, no shell metacharacters, no "..".
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(path) || path.includes("..")) {
    throw new Error(`Refusing to build command: unsafe path "${path}"`);
  }
  return path;
}

function sanitizeTail(tail: number): number {
  if (!Number.isInteger(tail) || tail <= 0 || tail > 100_000) {
    throw new Error(`Refusing to build command: unsafe tail line count "${tail}"`);
  }
  return tail;
}
