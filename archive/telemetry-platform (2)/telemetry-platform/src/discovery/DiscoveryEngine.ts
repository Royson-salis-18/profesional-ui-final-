import type { Connection } from "../connection/Connection.js";
import { REMOTE_COMMANDS } from "../connection/RemoteCommand.js";
import { parseDockerPs, parseLabelsString, parsePortsString } from "./parsers/dockerPs.js";
import { parseDockerInspect } from "./parsers/dockerInspect.js";
import { parseComposeDependsOn } from "./parsers/composeDependsOn.js";
import { deriveServiceName, buildServiceId } from "./serviceIdentity.js";
import { classifyService } from "./classifyService.js";
import type { Service, Dependency } from "../types/service.js";
import type { ArchitectureInventory, HostMetadata } from "../types/architecture.js";

export interface DiscoveryResult {
  architecture: ArchitectureInventory;
  services: Service[];
  dependencies: Dependency[];
}

/**
 * Runs one discovery cycle against a connected target. Tolerant of
 * partial failure per spec section 48: if Docker is unavailable, host
 * metadata is still returned and services/dependencies come back empty
 * rather than the whole discovery call throwing.
 */
export class DiscoveryEngine {
  constructor(
    private readonly targetId: string,
    private readonly connection: Connection,
  ) {}

  async discover(): Promise<DiscoveryResult> {
    const warnings: string[] = [];
    const now = new Date().toISOString();

    const host = await this.discoverHost(warnings);

    if (!host.dockerAvailable) {
      return {
        architecture: {
          schemaVersion: "1.0",
          target: host,
          serviceCount: 0,
          networkCount: 0,
          networks: [],
          warnings,
        },
        services: [],
        dependencies: [],
      };
    }

    const services = await this.discoverServices(warnings);
    const networkDependencies = this.buildNetworkCandidateDependencies(services);
    const composeDependencies = await this.discoverComposeDependencies(services, warnings);
    const dependencies = mergeDependencies(networkDependencies, composeDependencies);

    const networks = [...new Set(services.flatMap((s) => s.networks))].sort();

    return {
      architecture: {
        schemaVersion: "1.0",
        target: host,
        serviceCount: services.length,
        networkCount: networks.length,
        networks,
        warnings,
      },
      services,
      dependencies,
    };
  }

  private async discoverHost(warnings: string[]): Promise<HostMetadata> {
    const [hostnameRes, dateRes, unameRes, dockerVersionRes] = await Promise.all([
      this.connection.execute(REMOTE_COMMANDS.hostname()),
      this.connection.execute(REMOTE_COMMANDS.dateUtc()),
      this.connection.execute(REMOTE_COMMANDS.unameAll()),
      this.connection.execute(REMOTE_COMMANDS.dockerVersion()),
    ]);

    const dockerAvailable = dockerVersionRes.exitCode === 0 && !dockerVersionRes.error;
    if (!dockerAvailable) {
      warnings.push(
        `Docker unavailable on ${this.targetId}: ${dockerVersionRes.error ?? dockerVersionRes.stderr ?? "unknown error"}`,
      );
    }

    return {
      targetId: this.targetId,
      hostname: hostnameRes.parsed ?? null,
      uname: unameRes.parsed ?? null,
      remoteUtcTime: dateRes.parsed ?? null,
      dockerAvailable,
      dockerVersion: dockerAvailable ? dockerVersionRes.stdout.trim() : null,
      discoveredAt: new Date().toISOString(),
    };
  }

  private async discoverServices(warnings: string[]): Promise<Service[]> {
    const psRes = await this.connection.execute(REMOTE_COMMANDS.dockerPs());
    if (psRes.error || psRes.exitCode !== 0) {
      warnings.push(`docker ps failed: ${psRes.error ?? psRes.stderr}`);
      return [];
    }

    const { entries, skippedLines } = parseDockerPs(psRes.stdout);
    if (skippedLines > 0) {
      warnings.push(`Skipped ${skippedLines} unparseable docker ps line(s)`);
    }

    const nowIso = new Date().toISOString();
    const services: Service[] = [];

    for (const entry of entries) {
      const labels = parseLabelsString(entry.Labels);
      const ports = parsePortsString(entry.Ports);

      const inspectRes = await this.connection.execute(REMOTE_COMMANDS.dockerInspect(entry.ID));
      const inspected =
        inspectRes.exitCode === 0 && !inspectRes.error
          ? parseDockerInspect(inspectRes.stdout)
          : null;
      if (!inspected) {
        warnings.push(`docker inspect failed for container ${entry.ID}: ${inspectRes.error ?? "unparseable"}`);
      }

      const mergedLabels = { ...labels, ...(inspected?.labels ?? {}) };
      const serviceName = deriveServiceName(entry.Names, mergedLabels);
      const serviceId = buildServiceId(this.targetId, serviceName);

      const classification = classifyService({
        name: serviceName,
        image: entry.Image,
        ports: ports.map((p) => p.containerPort),
        labels: mergedLabels,
      });

      services.push({
        targetId: this.targetId,
        serviceId,
        name: serviceName,
        displayName: serviceName,
        type: classification.type,
        containerId: entry.ID,
        image: entry.Image,
        state: normalizeState(inspected?.state ?? entry.State),
        status: entry.Status,
        host: this.targetId,
        ports,
        networks: inspected?.networks.map((n) => n.networkName) ?? [],
        addresses: inspected?.networks.map((n) => n.ipAddress).filter((a): a is string => !!a) ?? [],
        metadata: {
          composeProject: mergedLabels["com.docker.compose.project"] ?? null,
          restartCount: inspected?.restartCount ?? null,
          mounts: inspected?.mounts ?? [],
        },
        classificationEvidence: classification.evidence,
        firstSeen: nowIso,
        lastSeen: nowIso,
      });
    }

    return services;
  }

  /**
   * Candidate edges from shared network membership. NEVER declared,
   * NEVER observed — network membership alone is not proof of anything
   * beyond "these two containers could reach each other" (spec section 9).
   */
  private buildNetworkCandidateDependencies(services: Service[]): Dependency[] {
    const nowIso = new Date().toISOString();
    const byNetwork = new Map<string, Service[]>();
    for (const service of services) {
      for (const network of service.networks) {
        const list = byNetwork.get(network) ?? [];
        list.push(service);
        byNetwork.set(network, list);
      }
    }

    const seen = new Set<string>();
    const dependencies: Dependency[] = [];
    for (const [network, members] of byNetwork) {
      for (const source of members) {
        for (const target of members) {
          if (source.serviceId === target.serviceId) continue;
          const key = `${source.serviceId}->${target.serviceId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          dependencies.push({
            targetId: this.targetId,
            sourceServiceId: source.serviceId,
            targetServiceId: target.serviceId,
            declared: false,
            observed: false,
            evidenceSources: ["docker-network"],
            firstSeen: nowIso,
            lastSeen: nowIso,
            metadata: { sharedNetwork: network },
          });
        }
      }
    }
    return dependencies;
  }

  /**
   * Best-effort: if a compose project label points at a config file we
   * can read, parse its depends_on into declared=true dependencies.
   * Silently yields nothing if the file isn't found/readable — this
   * must never block discovery of everything else.
   */
  private async discoverComposeDependencies(
    services: Service[],
    warnings: string[],
  ): Promise<Dependency[]> {
    const nowIso = new Date().toISOString();
    const composeFiles = new Set<string>();
    for (const service of services) {
      const configFiles = (service.metadata as Record<string, unknown>)["composeConfigFiles"];
      if (typeof configFiles === "string") composeFiles.add(configFiles);
    }
    // Fallback: many stacks keep a docker-compose.yml at a predictable path.
    // We do not guess paths beyond what discovery evidence provided.
    if (composeFiles.size === 0) return [];

    const byName = new Map(services.map((s) => [s.name, s]));
    const dependencies: Dependency[] = [];

    for (const filePath of composeFiles) {
      try {
        const result = await this.connection.execute(REMOTE_COMMANDS.catFile(filePath));
        if (result.exitCode !== 0 || result.error) {
          warnings.push(`Could not read compose file ${filePath}: ${result.error ?? result.stderr}`);
          continue;
        }
        const composeDeps = parseComposeDependsOn(result.stdout);
        for (const dep of composeDeps) {
          const source = byName.get(dep.sourceServiceName);
          const target = byName.get(dep.targetServiceName);
          if (!source || !target) continue;
          dependencies.push({
            targetId: this.targetId,
            sourceServiceId: source.serviceId,
            targetServiceId: target.serviceId,
            declared: true,
            observed: false,
            evidenceSources: ["compose"],
            firstSeen: nowIso,
            lastSeen: nowIso,
            metadata: { composeFile: filePath },
          });
        }
      } catch (err) {
        warnings.push(
          `Failed parsing compose file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return dependencies;
  }
}

/** Merge network-candidate and compose-declared edges, upgrading in place when both exist for the same pair. */
function mergeDependencies(networkDeps: Dependency[], composeDeps: Dependency[]): Dependency[] {
  const byKey = new Map<string, Dependency>();
  for (const dep of networkDeps) {
    byKey.set(`${dep.sourceServiceId}->${dep.targetServiceId}`, dep);
  }
  for (const dep of composeDeps) {
    const key = `${dep.sourceServiceId}->${dep.targetServiceId}`;
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, {
        ...existing,
        declared: true,
        evidenceSources: [...new Set([...existing.evidenceSources, ...dep.evidenceSources])],
      });
    } else {
      byKey.set(key, dep);
    }
  }
  return [...byKey.values()];
}

function normalizeState(state: string | undefined): Service["state"] {
  switch (state) {
    case "running":
    case "exited":
    case "restarting":
    case "paused":
    case "dead":
      return state;
    default:
      return "unknown";
  }
}
