/**
 * Runtime interaction evidence. These are ONLY created when a real
 * log/trace/network observation exists — never synthesized defaults.
 */

import type { DependencyEvidenceSource } from "./service.js";

export interface InteractionEvent {
  timestamp: string; // ISO-8601 UTC
  targetId: string;

  sourceServiceId?: string;
  targetServiceId?: string;

  protocol?: "http" | "https" | "tcp" | "grpc" | "amqp" | "unknown";
  method?: string;
  route?: string;
  statusCode?: number;
  latencyMs?: number;

  bytesSent?: number;
  bytesReceived?: number;

  traceId?: string;
  spanId?: string;
  requestId?: string;

  evidenceSource: DependencyEvidenceSource;
}
