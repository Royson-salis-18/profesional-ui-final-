/**
 * Parses `docker inspect <id>` output — a JSON array with exactly one
 * object for a single-container inspect call.
 */

export interface DockerInspectNetwork {
  networkName: string;
  ipAddress: string | null;
  aliases: string[];
}

export interface DockerInspectResult {
  id: string;
  name: string; // without leading "/"
  image: string;
  state: string;
  status: string | null;
  restartCount: number | null;
  startedAt: string | null;
  labels: Record<string, string>;
  env: string[];
  networks: DockerInspectNetwork[];
  mounts: { source: string; destination: string }[];
}

export function parseDockerInspect(stdout: string): DockerInspectResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const obj = arr[0] as Record<string, unknown> | undefined;
  if (!obj) return null;

  const state = (obj.State as Record<string, unknown> | undefined) ?? {};
  const config = (obj.Config as Record<string, unknown> | undefined) ?? {};
  const networkSettings =
    (obj.NetworkSettings as Record<string, unknown> | undefined) ?? {};
  const networksObj =
    (networkSettings.Networks as Record<string, unknown> | undefined) ?? {};

  const networks: DockerInspectNetwork[] = Object.entries(networksObj).map(
    ([networkName, netInfo]) => {
      const info = netInfo as Record<string, unknown>;
      return {
        networkName,
        ipAddress: (info.IPAddress as string) || null,
        aliases: Array.isArray(info.Aliases) ? (info.Aliases as string[]) : [],
      };
    },
  );

  const mountsRaw = Array.isArray(obj.Mounts) ? (obj.Mounts as Record<string, unknown>[]) : [];
  const mounts = mountsRaw.map((m) => ({
    source: (m.Source as string) ?? "",
    destination: (m.Destination as string) ?? "",
  }));

  const name = typeof obj.Name === "string" ? obj.Name.replace(/^\//, "") : "";

  return {
    id: (obj.Id as string) ?? "",
    name,
    image: (config.Image as string) ?? "",
    state: (state.Status as string) ?? "unknown",
    status: (state.Status as string) ?? null,
    restartCount: typeof obj.RestartCount === "number" ? (obj.RestartCount as number) : null,
    startedAt: (state.StartedAt as string) ?? null,
    labels: (config.Labels as Record<string, string>) ?? {},
    env: Array.isArray(config.Env) ? (config.Env as string[]) : [],
    networks,
    mounts,
  };
}
