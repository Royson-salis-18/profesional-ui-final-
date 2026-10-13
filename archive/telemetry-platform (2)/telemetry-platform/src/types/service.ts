/**
 * Normalized Service + Dependency models.
 *
 * IMPORTANT SEMANTIC RULE (spec section 61):
 *   Observed != declared. Connected != communicated.
 * A Dependency with only `declared: true` is NOT proof of runtime traffic.
 */

export type ServiceType =
  | "service"
  | "frontend"
  | "backend"
  | "gateway"
  | "database"
  | "queue"
  | "cache"
  | "worker"
  | "auth"
  | "storage"
  | "infrastructure"
  | "unknown";

export type ServiceState =
  | "running"
  | "exited"
  | "restarting"
  | "paused"
  | "dead"
  | "unknown";

export interface ServicePort {
  containerPort: number;
  hostPort?: number;
  protocol: "tcp" | "udp";
}

export interface Service {
  targetId: string;
  /** Stable identity: derived from targetId + normalized container/service name. Never random. */
  serviceId: string;
  name: string;
  displayName: string;
  type: ServiceType;
  containerId?: string;
  image?: string;
  state: ServiceState;
  status?: string;
  host: string;
  ports: ServicePort[];
  networks: string[];
  addresses: string[];
  metadata: Record<string, unknown>;
  /** Evidence used to classify `type`, for auditability. */
  classificationEvidence: string[];
  firstSeen: string; // ISO-8601 UTC
  lastSeen: string; // ISO-8601 UTC
}

export type DependencyEvidenceSource =
  | "compose"
  | "docker-network"
  | "network-tcp"
  | "http-log"
  | "otel"
  | "application-log";

export interface Dependency {
  targetId: string;
  sourceServiceId: string;
  targetServiceId: string;
  /** True if this edge comes from static configuration (e.g. compose file). */
  declared: boolean;
  /** True only if real runtime evidence of communication exists. */
  observed: boolean;
  evidenceSources: DependencyEvidenceSource[];
  firstSeen: string;
  lastSeen: string;
  metadata: Record<string, unknown>;
}
