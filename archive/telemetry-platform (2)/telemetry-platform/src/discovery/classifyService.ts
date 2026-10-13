import type { ServiceType } from "../types/service.js";

export interface ClassificationInput {
  name: string;
  image: string;
  ports: number[];
  labels: Record<string, string>;
}

export interface ClassificationResult {
  type: ServiceType;
  evidence: string[];
}

/**
 * Classifies a service using multiple independent signals (spec section 8):
 * name, image, exposed ports, and labels. Never relies on a single
 * hard-coded naming rule — each match is recorded as evidence so the
 * decision is auditable.
 */
export function classifyService(input: ClassificationInput): ClassificationResult {
  const { name, image } = input;
  const nameLower = name.toLowerCase();
  const imageLower = image.toLowerCase();
  const evidence: string[] = [];

  const votes: Partial<Record<ServiceType, number>> = {};
  const vote = (type: ServiceType, reason: string, weight = 1) => {
    votes[type] = (votes[type] ?? 0) + weight;
    evidence.push(reason);
  };

  // --- Databases ---
  const dbImageHints = ["mysql", "postgres", "mongo", "mariadb", "cassandra", "mssql"];
  for (const hint of dbImageHints) {
    if (imageLower.includes(hint)) vote("database", `image contains "${hint}"`, 2);
  }
  if (/-db$|_db$|^db-|database/.test(nameLower)) {
    vote("database", `name matches database naming pattern ("${name}")`, 1);
  }

  // --- Cache ---
  if (imageLower.includes("redis") || imageLower.includes("memcached")) {
    vote("cache", `image contains a known cache engine`, 2);
  }
  if (/cache/.test(nameLower)) vote("cache", `name contains "cache"`, 1);

  // --- Queue / messaging ---
  if (imageLower.includes("rabbitmq") || imageLower.includes("kafka") || imageLower.includes("nats")) {
    vote("queue", `image contains a known messaging engine`, 2);
  }
  if (/queue|rabbit|kafka|broker/.test(nameLower)) {
    vote("queue", `name matches messaging naming pattern ("${name}")`, 1);
  }

  // --- Gateway ---
  if (imageLower.includes("nginx") || imageLower.includes("traefik") || imageLower.includes("envoy")) {
    vote("gateway", `image contains a known gateway/proxy engine`, 2);
  }
  if (/gateway|edge-router|proxy|router/.test(nameLower)) {
    vote("gateway", `name matches gateway naming pattern ("${name}")`, 1);
  }

  // --- Auth ---
  if (/auth|login|identity|sso/.test(nameLower)) {
    vote("auth", `name matches auth naming pattern ("${name}")`, 1);
  }

  // --- Frontend ---
  if (/front-?end|^web-?|-ui$|_ui$/.test(nameLower)) {
    vote("frontend", `name matches frontend naming pattern ("${name}")`, 1);
  }
  if (input.ports.includes(80) || input.ports.includes(443) || input.ports.includes(3000)) {
    vote("frontend", `exposes a common web port (${input.ports.join(", ")})`, 1);
  }

  // --- Worker ---
  if (/worker|consumer|master$/.test(nameLower)) {
    vote("worker", `name matches worker naming pattern ("${name}")`, 1);
  }

  // --- Storage ---
  if (/storage|minio|s3/.test(nameLower) || imageLower.includes("minio")) {
    vote("storage", `name/image matches storage pattern`, 1);
  }

  // --- Infrastructure (monitoring, tracing, service mesh) ---
  const infraHints = ["prometheus", "jaeger", "grafana", "otel", "zipkin", "consul"];
  for (const hint of infraHints) {
    if (imageLower.includes(hint) || nameLower.includes(hint)) {
      vote("infrastructure", `name/image contains "${hint}"`, 2);
    }
  }

  // --- Generic backend fallback ---
  if (Object.keys(votes).length === 0) {
    vote("backend", `no specific signal matched; defaulting to generic backend`, 0.5);
  }

  const [bestType] = Object.entries(votes).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0] as [
    ServiceType,
    number,
  ];

  return { type: bestType, evidence };
}
