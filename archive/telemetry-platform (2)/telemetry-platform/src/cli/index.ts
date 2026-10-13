#!/usr/bin/env node
import { loadTargetConfig } from "../config/loadTarget.js";
import { ConnectionManager } from "../connection/ConnectionManager.js";
import { StorageManager } from "../storage/StorageManager.js";
import { REMOTE_COMMANDS } from "../connection/RemoteCommand.js";
import { DiscoveryEngine } from "../discovery/DiscoveryEngine.js";
import { MetricCollector } from "../collection/MetricCollector.js";
import type { Service } from "../types/service.js";

/**
 * PHASE 1 CLI SKELETON.
 *
 * Only wires up what Phase 1 actually built: config loading, a live
 * connectivity check, and storage initialization. Later phases (discovery,
 * collect, build-dataset, analytics, export) are stubbed and will fail
 * loudly with a "not implemented yet" message rather than silently no-op.
 */

const USAGE = `
collector <command> [options]

Commands:
  check-connection --target <path>   Connect to a target and run a basic
                                      liveness check (hostname, date, uname).
  init-storage     --target <path>   Create the layered storage directories
                                      for a target's outputDirectory.
  discover         --target <path>   Discover host + Docker containers,
                                      classify services, derive declared/
                                      candidate dependencies, and write
                                      architecture.json / services.json /
                                      dependencies.json.
  collect-metrics  --target <path>   Run ONE round of docker-stats-based
                                      metric collection against the
                                      services already discovered (run
                                      "discover" first) and append to
                                      raw/metrics.jsonl.

Not implemented yet (later phases):
  collect (continuous loop), build-dataset, analytics, export
`;

function getArg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }

  const targetPath = getArg(rest, "--target");
  if (!targetPath) {
    console.error("Missing required --target <path> argument.");
    process.exit(1);
  }

  const target = loadTargetConfig(targetPath!);

  switch (command) {
    case "check-connection": {
      const manager = new ConnectionManager(target);
      console.log(`Connecting to target "${target.id}" (${target.connection.host})...`);
      const conn = await manager.getConnection();
      const [hostname, dateUtc, uname] = await Promise.all([
        conn.execute(REMOTE_COMMANDS.hostname()),
        conn.execute(REMOTE_COMMANDS.dateUtc()),
        conn.execute(REMOTE_COMMANDS.unameAll()),
      ]);
      console.log("Connection OK.");
      console.log(`  hostname: ${hostname.parsed ?? hostname.error}`);
      console.log(`  remote UTC time: ${dateUtc.parsed ?? dateUtc.error}`);
      console.log(`  uname -a: ${uname.parsed ?? uname.error}`);
      await manager.close();
      break;
    }

    case "init-storage": {
      const storage = new StorageManager(target.storage.outputDirectory);
      storage.writeJson("raw", "target.json", target);
      console.log(
        `Initialized storage layers under ${target.storage.outputDirectory} for target "${target.id}".`,
      );
      break;
    }

    case "discover": {
      const manager = new ConnectionManager(target);
      const conn = await manager.getConnection();
      console.log(`Discovering architecture for target "${target.id}"...`);
      const engine = new DiscoveryEngine(target.id, conn);
      const result = await engine.discover();

      const storage = new StorageManager(target.storage.outputDirectory);
      storage.writeJson("raw", "architecture.json", result.architecture);
      storage.writeJson("raw", "services.json", result.services);
      storage.writeJson("raw", "dependencies.json", result.dependencies);

      console.log(`  Docker available: ${result.architecture.target.dockerAvailable}`);
      console.log(`  Services discovered: ${result.services.length}`);
      console.log(`  Dependency edges: ${result.dependencies.length}`);
      if (result.architecture.warnings.length > 0) {
        console.log(`  Warnings:`);
        for (const w of result.architecture.warnings) console.log(`    - ${w}`);
      }
      console.log(`  Written to ${target.storage.outputDirectory}/raw/{architecture,services,dependencies}.json`);
      await manager.close();
      break;
    }

    case "collect-metrics": {
      const storage = new StorageManager(target.storage.outputDirectory);
      const services = storage.readJson<Service[]>("raw", "services.json");
      if (!services || services.length === 0) {
        console.error(
          `No discovered services found in ${target.storage.outputDirectory}/raw/services.json. Run "discover" first.`,
        );
        process.exit(1);
      }

      const manager = new ConnectionManager(target);
      const conn = await manager.getConnection();
      console.log(`Collecting metrics for ${services!.length} known service(s)...`);
      const collector = new MetricCollector(target.id, conn);
      const result = await collector.collectOnce(services!);

      storage.appendRecords("raw", "metrics", result.samples);
      console.log(`  Samples collected: ${result.samples.length}`);
      if (result.warnings.length > 0) {
        console.log(`  Warnings:`);
        for (const w of result.warnings) console.log(`    - ${w}`);
      }
      console.log(`  Appended to ${target.storage.outputDirectory}/raw/metrics.jsonl`);
      await manager.close();
      break;
    }

    case "collect":
    case "build-dataset":
    case "analytics":
    case "export":
      console.error(
        `Command "${command}" is part of a later phase and is not implemented yet. See project spec sections 62-63.`,
      );
      process.exit(2);
      break; // eslint-disable-line no-unreachable

    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
