/**
 * Normalized log event model. Raw message is always retained for auditability.
 */

export type LogLevel =
  | "trace"
  | "debug"
  | "info"
  | "warning"
  | "error"
  | "fatal"
  | "unknown";

export interface LogEvent {
  timestamp: string; // ISO-8601 UTC, normalized event time
  originalTimestamp?: string; // as it appeared in source, pre-normalization
  collectorReceivedAt: string;

  targetId: string;
  serviceId: string;
  containerId?: string;

  level: LogLevel;
  message: string;
  source: string; // e.g. "stdout", "stderr", "nginx-access"
  rawMessage: string;

  // Optional fields extracted by a LogParser — never invented if absent
  route?: string;
  method?: string;
  statusCode?: number;
  latencyMs?: number;
  bytes?: number;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  clientIp?: string;
  serverIp?: string;

  valid: boolean;
  validationReason?: string;
}
