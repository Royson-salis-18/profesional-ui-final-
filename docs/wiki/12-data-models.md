# Data Models — TypeScript Interfaces Reference

All models are defined in two places:
- **Server canonical:** `server/models/` (individual files per type)
- **Client mirror:** `client/src/types/index.ts` (flat file, kept in sync manually)

---

## `ServiceNode`

```typescript
interface ServiceNode {
  // Identity
  id:      string;  // Canonical: "${targetId}:${serviceName}" e.g. "sock-shop:catalogue"
  name:    string;  // Short service name: "catalogue"
  type:    'gateway' | 'service' | 'database' | 'queue' | 'frontend' | 'infrastructure' | 'external';
  project: string;  // targetId: "sock-shop"

  // Health
  status:   'healthy' | 'degraded' | 'critical' | 'unknown';
  lastSeen: string;  // ISO-8601 — server clock, not collector clock

  // Container metadata
  metadata: {
    containerId?:   string;   // Docker container ID (short or full)
    image?:         string;   // Docker image name + tag
    ports?:         string[]; // ["80/tcp", "443/tcp"]
    uptime?:        string;   // Human-readable: "2d 14h 32m"
    restartCount?:  number;
    state?:         string;   // Docker state: "running", "exited", "dead"
    [key: string]:  any;      // Extensible for future fields
  };

  // Current metrics (latest values, fast path from ingestRemote)
  metrics: {
    cpu?:            number;        // 0–100 (%) — one decimal place
    memory?:         number;        // Absolute bytes
    memoryPercent?:  number;        // 0–100 (%)
    networkRx?:      number;        // Cumulative bytes received
    networkTx?:      number;        // Cumulative bytes transmitted
    latency?:        number | null; // Average ms (from HTTP interactions, not Docker stats)
    requestRate?:    number | null; // Requests/second (from HTTP interactions)
    errorRate?:      number | null; // 0.0–1.0 (from HTTP interactions)
  } | null;

  // Analytics (computed/ML)
  analytics?: {
    anomalyScore?:       number;        // 0.0–1.0 from IsolationForest (higher = more anomalous)
    anomalyPersistent?:  boolean;       // Sustained anomaly (N consecutive windows above threshold)
    healthScore?:        number | null; // Composite health score (GraphAnalytics)
    criticality?:        number | null; // How critical to the system (centrality-based)
    centrality?:         number | null; // Graph centrality score
    upstreamCount?:      number;        // Number of services that depend on this
    downstreamCount?:    number;        // Number of services this depends on
  };
}
```

### Key design notes

**`lastSeen` is always the server's clock:** The collector's machine could have clock skew. Using the server's clock ensures staleness detection (`checkTargetStaleness()`) is consistent.

**`metrics.latency` is null for most services:** Only services whose logs are parsed (gateways, configured services) have HTTP-derived latency. Docker stats don't include latency. Showing `null` is better than showing `0` which would imply "zero latency."

**`metadata` is an open record:** New fields can be added by adapters without changing the interface. The GraphStore merges metadata spreads: `{ ...existing.metadata, ...incoming.metadata }`.

---

## `DependencyEdge`

```typescript
interface DependencyEdge {
  // Identity
  id:     string;  // "${source}->${target}" e.g. "sock-shop:front-end->sock-shop:catalogue"
  source: string;  // Source node ID (canonical)
  target: string;  // Target node ID (canonical)

  // Edge classification
  type:      'http' | 'database' | 'message' | 'dependency';
  protocol?: string;  // "http", "https", "amqp", "rabbitmq", "tcp"

  // Evidence flags
  declared:        boolean;       // true = found in Docker Compose depends_on
  observed:        boolean;       // true = confirmed at runtime (log or TCP)
  evidenceSources: string[];      // ["compose-config", "http-log", "proc-net-tcp"]

  // Timestamps
  firstSeen?: string;  // ISO-8601 — when first observed
  lastSeen?:  string;  // ISO-8601 — most recent confirmation

  // HTTP metrics (from InteractionEvent aggregation)
  metrics: {
    requestCount?: number | null;
    errorCount?:   number | null;
    errorRate?:    number | null;  // 0.0–1.0
    latency?:      number | null;  // Average ms
    p50Latency?:   number | null;
    p95Latency?:   number | null;
    p99Latency?:   number | null;
    bytesSent?:    number | null;
  } | null;

  // HTTP status code breakdown
  statusCodeDistribution?: Record<string, number>;  // {"200": 1247, "404": 3, "500": 12}

  // TCP observation heat
  activity?: {
    samplesPerMin: number;  // TCP connection observations per minute
    windowSec:     number;  // Age of the measurement window
    lastSeen:      string;  // When last observed
  };

  // Computed status
  status: 'active' | 'degraded' | 'failed' | 'unknown';
}
```

### Evidence sources

| Value | Meaning |
|---|---|
| `compose-config` | Found in `depends_on` of the Compose file |
| `http-log` | Observed via container log parsing |
| `proc-net-tcp` | Observed via `/proc/net/tcp` snapshot |

An edge can accumulate multiple sources over time. The `evidenceSources.push()` in `ingestRemote()` deduplicates with `includes()` before appending.

---

## `Target`

```typescript
interface Target {
  targetId:     string;  // Short unique ID: "sock-shop"
  displayName:  string;  // Human label: "Sock Shop AWS"
  environment:  'local' | 'remote' | 'aws' | string;
  region?:      string;  // AWS region: "ap-south-1"

  // SSH connection info (from remote_config.json)
  host?:         string;  // EC2 public IP
  sshUsername?:  string;
  sshKeyPath?:   string;
  transport?:    'http' | 'ssh-tunnel' | string;

  // Liveness
  status:   'LIVE' | 'STALE' | 'OFFLINE' | 'NO DATA';
  lastSeen: string | null;

  // HTTP endpoint (for health pings)
  baseUrl?:        string;  // "http://18.206.136.26:80"
  publicPort?:     number;
  endpointStatus?: 'REACHABLE' | 'UNREACHABLE' | 'UNCONFIGURED';

  // Feature flags
  capabilities?: {
    dockerMetrics?:    boolean;
    serviceHealth?:    boolean;
    topology?:         boolean;
    httpInteractions?: boolean;
    traces?:           boolean;
  };

  // Discovery summary
  discoverySummary?: {
    serviceCount:    number;
    endpointCount:   number;
    lastDiscoveredAt: string;
  };
}
```

---

## `MetricSnapshot`

```typescript
interface MetricSnapshot {
  timestamp:      string;
  cpu?:           number;        // 0–100 (%)
  memory?:        number;        // Absolute bytes
  memoryPercent?: number;        // 0–100 (%)
  networkRx?:     number;        // Cumulative bytes
  networkTx?:     number;        // Cumulative bytes
  latency?:       number | null;
  requestRate?:   number | null;
  errorRate?:     number | null;
  restartCount?:  number;
}
```

Stored in `MetricStore` ring buffer. Retrieved via `GET /api/nodes/:id/metrics?range=5m`.

---

## `InteractionEvent`

```typescript
interface InteractionEvent {
  timestamp:      string;
  source:         string;   // Canonical node ID (or "external"/"unknown-upstream")
  target:         string;   // Canonical node ID
  protocol:       string;   // "http", "amqp", etc.
  method?:        string;   // "GET", "POST", etc.
  route?:         string;   // "/catalogue", "/orders"
  statusCode?:    number | null;
  latencyMs?:     number | null;
  bytesSent?:     number | null;
  bytesReceived?: number | null;
  success?:       boolean | null;  // statusCode < 400
  evidenceSource: string;           // "http-log"
}
```

---

## `ConnectionEvent`

```typescript
// SSH-sampled TCP connection from /proc/net/tcp
// NOT a distributed trace span
interface ConnectionEvent {
  timestamp:       string;
  targetId:        string;  // Which target reported this
  sourceServiceId: string;  // Canonical node ID
  destServiceId:   string;  // Canonical node ID
  destPort:        number;  // Destination port
  state:           string;  // "ESTABLISHED"
}
```

---

## `TelemetryEnvelope`

The payload posted by the remote collector to `POST /api/ingest`:

```typescript
interface TelemetryEnvelope {
  targetId: string;
  events: {
    nodes:            Partial<ServiceNode>[];
    edges:            Partial<DependencyEdge>[];
    metrics:          { nodeId: string; snapshot: MetricSnapshot }[];
    interactions:     InteractionEvent[];
    connectionEvents: ConnectionEvent[];
  };
}
```

All arrays are optional (can be empty `[]`). The server processes only what's present.

---

## `AnomalyRecord`

Used internally by `RCAEngine` and `IncidentManager`:

```typescript
interface AnomalyRecord {
  nodeId:      string;
  targetId:    string;
  score:       number;       // 0.0–1.0 from IsolationForest
  persistent:  boolean;      // Sustained above threshold
  detectedAt:  string;       // ISO-8601
}
```

---

## `Incident`

```typescript
interface Incident {
  id:            string;
  targetId:      string;
  status:        'NORMAL' | 'INCIDENT' | 'RECOVERING' | 'RESOLVED';
  startedAt:     string;   // ISO-8601
  resolvedAt?:   string;   // ISO-8601
  primaryRootCause?: {
    nodeId:      string;
    nodeName:    string;
    score:       number;
    confidence:  'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  };
  candidateCauses:    CandidateCause[];
  affectedServices:   string[];  // Node IDs
  propagationPath:    PropagationStep[];
  evidence:           EvidenceItem[];
  explanation:        RCAExplanation;
}
```
