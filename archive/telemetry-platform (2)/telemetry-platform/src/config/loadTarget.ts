import { readFileSync } from "node:fs";
import { load as parseYaml } from "js-yaml";
import type { TargetConfig } from "../types/target.js";

/**
 * Loads and validates a target.yaml configuration file. Never logs or
 * echoes credential material (private key path is fine to log; key
 * contents never pass through this module).
 */
export function loadTargetConfig(path: string): TargetConfig {
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw) as unknown;
  return validateTargetConfig(parsed, path);
}

export function validateTargetConfig(parsed: unknown, sourcePath: string): TargetConfig {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid target config at ${sourcePath}: not an object`);
  }
  const obj = parsed as Record<string, unknown>;
  const target = obj.target as Record<string, unknown> | undefined;
  const connection = obj.connection as Record<string, unknown> | undefined;
  const collector = obj.collector as Record<string, unknown> | undefined;
  const storage = obj.storage as Record<string, unknown> | undefined;

  if (!target?.id || typeof target.id !== "string") {
    throw new Error(`Invalid target config at ${sourcePath}: target.id is required`);
  }
  if (!target.name || typeof target.name !== "string") {
    throw new Error(`Invalid target config at ${sourcePath}: target.name is required`);
  }
  if (!connection || connection.type !== "ssh") {
    throw new Error(
      `Invalid target config at ${sourcePath}: connection.type must be "ssh" (only supported type currently)`,
    );
  }
  for (const field of ["host", "username", "privateKeyPath"]) {
    if (!connection[field] || typeof connection[field] !== "string") {
      throw new Error(`Invalid target config at ${sourcePath}: connection.${field} is required`);
    }
  }
  if (!collector) {
    throw new Error(`Invalid target config at ${sourcePath}: collector section is required`);
  }
  if (!storage?.outputDirectory || typeof storage.outputDirectory !== "string") {
    throw new Error(
      `Invalid target config at ${sourcePath}: storage.outputDirectory is required`,
    );
  }

  const config: TargetConfig = {
    id: target.id as string,
    name: target.name as string,
    environment: (target.environment as string) ?? "unknown",
    region: target.region as string | undefined,
    schemaVersion: "1.0",
    connection: {
      type: "ssh",
      host: connection.host as string,
      port: (connection.port as number) ?? 22,
      username: connection.username as string,
      privateKeyPath: connection.privateKeyPath as string,
      passphraseEnvVar: connection.passphraseEnvVar as string | undefined,
      readyTimeoutMs: (connection.readyTimeoutMs as number) ?? 15_000,
    },
    application: obj.application
      ? (obj.application as TargetConfig["application"])
      : undefined,
    collector: {
      intervalSeconds: (collector.intervalSeconds as number) ?? 5,
      logLookbackSeconds: (collector.logLookbackSeconds as number) ?? 30,
      windowSeconds: (collector.windowSeconds as number) ?? 5,
      logTailLines: (collector.logTailLines as number) ?? 500,
    },
    storage: {
      outputDirectory: storage.outputDirectory as string,
    },
  };

  return config;
}
