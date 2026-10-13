/**
 * The output of Phase 2 discovery: a normalized inventory of the host,
 * containers, and declared/candidate dependencies. This is DISCOVERED
 * ARCHITECTURE ONLY — no runtime traffic claims live here (spec section 2).
 */

export interface HostMetadata {
  targetId: string;
  hostname: string | null;
  uname: string | null;
  remoteUtcTime: string | null;
  dockerAvailable: boolean;
  dockerVersion: string | null;
  discoveredAt: string; // ISO-8601 UTC — when this inventory was built
}

export interface ArchitectureInventory {
  schemaVersion: "1.0";
  target: HostMetadata;
  serviceCount: number;
  networkCount: number;
  networks: string[];
  /** Discovery-time issues that did not stop the run (spec section 48). */
  warnings: string[];
}
