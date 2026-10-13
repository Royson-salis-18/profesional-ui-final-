/**
 * Target-agnostic architecture model.
 *
 * A "Target" is any environment the collector can connect to and observe.
 * The collector must never be hard-coded around a specific target — new
 * targets are added by writing a config file (see examples/target.example.yaml),
 * not by copying code.
 */

export type ConnectionType = "ssh";

export interface SSHConnectionConfig {
  type: "ssh";
  host: string;
  port: number;
  username: string;
  /** Path to a private key ON DISK. The key content is never embedded in config. */
  privateKeyPath: string;
  /** Optional passphrase env var name (never store the raw passphrase in config). */
  passphraseEnvVar?: string;
  /** Connection timeout in ms. */
  readyTimeoutMs?: number;
}

export type ConnectionConfig = SSHConnectionConfig;

export interface CollectorConfig {
  intervalSeconds: number;
  logLookbackSeconds: number;
  windowSeconds: number;
  /** Bounded log tail per poll, to avoid unbounded memory use. */
  logTailLines?: number;
}

export interface StorageConfig {
  outputDirectory: string;
}

export interface ApplicationAdapterConfig {
  /** Name of a registered adapter, e.g. "sockshop", "vertikal", or "generic". */
  adapter: string;
  /** Arbitrary adapter-specific knowledge (known services, routes, etc). */
  knownServices?: string[];
  knownRoutePrefixes?: string[];
}

export interface TargetConfig {
  id: string;
  name: string;
  environment: string;
  region?: string;
  connection: ConnectionConfig;
  application?: ApplicationAdapterConfig;
  collector: CollectorConfig;
  storage: StorageConfig;
  /** Schema version for this config file shape. */
  schemaVersion: "1.0";
}
