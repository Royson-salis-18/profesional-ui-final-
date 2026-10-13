# Remote Collector — Telemetry Sources & Design

**File:** `remote-collector/index.ts`

The remote collector is a standalone Node.js process deployed on each EC2 instance. It runs alongside the target application and requires access to `/var/run/docker.sock`.

---

## Deployment Context

The collector is stateless and restartable at any time. It:
1. Reads from the Docker socket and `/proc/net/tcp`
2. Packages data into `TelemetryEnvelope` payloads
3. POSTs them to `MAPPER_URL/api/ingest`

```bash
# Environment variables:
MAPPER_URL=http://127.0.0.1:3001   # Reaches backend via SSH reverse tunnel
INGEST_TOKEN=mapper-secret-token    # Bearer auth for /api/ingest
TARGET_ID=sock-shop                 # Identifier sent in all envelopes
POLLING_INTERVAL=5000               # ms between collection cycles
```

**SSH reverse tunnel:** The backend server opens `-R 3001:localhost:3001` when SSH-connecting to EC2. This means `127.0.0.1:3001` on the EC2 instance routes to the mapper backend. The collector never needs a public IP or any inbound firewall rules.

---

## Telemetry Source 1 — Docker Socket

### Container Stats (CPU, Memory, Network)

```typescript
const stats = await container.stats({ stream: false });  // one-shot snapshot

// CPU calculation — Docker provides deltas:
const cpuDelta    = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
const numCPUs     = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
const cpuPercent  = (cpuDelta / systemDelta) * numCPUs * 100;

// Memory:
const memUsage    = stats.memory_stats.usage;
const memLimit    = stats.memory_stats.limit;
const memPercent  = (memUsage / memLimit) * 100;

// Network I/O (sum across all virtual interfaces):
let networkRx = 0, networkTx = 0;
for (const iface of Object.values(stats.networks || {})) {
  networkRx += iface.rx_bytes;
  networkTx += iface.tx_bytes;
}
```

**Note:** `networkRx`/`networkTx` are **cumulative** counters, not rates. The ML pipeline's `preprocess.py` converts them to rates (Δ bytes/second) during feature engineering.

### Container Events (Real-time State Changes)

```typescript
const stream = await docker.getEvents({ filters: { type: ['container'] } });
stream.on('data', (chunk) => {
  const event = JSON.parse(chunk.toString());
  if (['start', 'die', 'stop', 'restart'].includes(event.Action)) {
    // Emit a node update with new status
  }
});
```

This gives near-instantaneous node status updates when containers start/stop — much faster than waiting for the next polling cycle.

---

## Telemetry Source 2 — Container Log Parsing

### Docker Log Framing

Docker's `container.logs()` stream multiplexes stdout and stderr into a single binary stream. Each log line is prefixed with an **8-byte header**:

```
Byte 0:   stream type (1=stdout, 2=stderr)
Bytes 1-3: padding (zeros)
Bytes 4-7: payload size (big-endian uint32)
Byte 8+:  log content
```

The collector strips this header before applying any regex:

```typescript
function demuxDockerLogs(buffer: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 8) break;
    const size = buffer.readUInt32BE(offset + 4);
    const line = buffer.slice(offset + 8, offset + 8 + size).toString('utf8').trim();
    if (line) lines.push(line);
    offset += 8 + size;
  }
  return lines;
}
```

**Why is this important?** Without stripping the header, the first 8 bytes of every log line are binary garbage. Regex patterns fail silently — no HTTP events are extracted, edge observability is blind.

### Standard Access Log Format (Apache/NGINX combined)

```typescript
const stdRegex = /^([0-9.]+).*?"([A-Z]+)\s+([^\s]+)\s+HTTP\/[0-9.]+"?\s+(\d+|-)?/;
const match = stdRegex.exec(line);
if (match) {
  const [, clientIp, method, path, statusCode] = match;
  // Cross-reference clientIp with ipToNameMap → sourceServiceId
}
```

Extracts: caller IP, HTTP method, URL path, status code.

### JSON Log Format (Traefik, NGINX with JSON logging, Kong)

```typescript
const parsed = JSON.parse(line);
if (parsed.upstream_response_time !== undefined) {
  // Traefik/NGINX JSON format
  interaction = {
    latencyMs:    parseFloat(parsed.upstream_response_time) * 1000,
    statusCode:   parseInt(parsed.status),
    bytesSent:    parseInt(parsed.bytes_sent),
    upstreamAddr: parsed.upstream_addr,  // → resolve to service name
  };
}
```

### IP → Service Name Resolution

Both log formats give an IP address for the upstream/caller. The collector builds an `ipToNameMap` from `docker inspect` output:

```typescript
const info = await container.inspect();
const ip = info.NetworkSettings.Networks[network]?.IPAddress;
if (ip) ipToNameMap.set(ip, derivedServiceName);
```

Matching a log line's `remote_addr` or `upstream_addr` against this map converts a raw IP into a `sourceServiceId`.

---

## Telemetry Source 3 — `/proc/net/tcp` Polling

Linux's `/proc/net/tcp` contains the kernel's TCP connection table. The collector reads it at each polling interval.

### File Format

```
sl   local_address    rem_address      st   ...
0:   00000000:0050    00000000:0000    0A   ...  (LISTEN on port 80)
1:   0F02A8C0:1F90    0302A8C0:C2EA    01   ...  (ESTABLISHED)
```

- `st = 01` → ESTABLISHED
- Addresses are **hexadecimal little-endian** IPv4
- `0F02A8C0` = bytes `0F 02 A8 C0` = `192.168.2.15` in little-endian

### Parsing

```typescript
function hexToIp(hex: string): string {
  const bytes = [];
  for (let i = 0; i < 8; i += 2) {
    bytes.unshift(parseInt(hex.slice(i, i + 2), 16));  // little-endian
  }
  return bytes.join('.');
}
```

### Connection Event Generation

```typescript
for (const line of procNetTcpLines) {
  const [, localHex, remoteHex, state] = line.trim().split(/\s+/);
  if (state !== '01') continue;  // Only ESTABLISHED

  const localIp  = hexToIp(localHex.split(':')[0]);
  const remoteIp = hexToIp(remoteHex.split(':')[0]);

  const localService  = ipToNameMap.get(localIp);
  const remoteService = ipToNameMap.get(remoteIp);

  if (localService && remoteService && localService !== remoteService) {
    connectionEvents.push({
      timestamp:       new Date().toISOString(),
      targetId,
      sourceServiceId: `${targetId}:${remoteService}`,
      destServiceId:   `${targetId}:${localService}`,
      destPort:        parseInt(localHex.split(':')[1], 16),
      state:           'ESTABLISHED',
    });
  }
}
```

### Known Limitations

1. **5-second sampling gap:** Connections that open and close within one polling interval are invisible. Short-lived health check pings may be missed.
2. **No latency:** `/proc/net/tcp` shows connection state, not timing.
3. **No request granularity:** One `ConnectionEvent` per active connection per poll, not per request.
4. **IPv4 only:** `/proc/net/tcp` is IPv4. IPv6 is in `/proc/net/tcp6` (not currently read).

These limitations are documented in the source code comments and in `TracesView.tsx`'s component docstring.

---

## Service Name Derivation

```typescript
function deriveServiceName(containerInfo: any): string {
  // Priority 1: Docker Compose label (always present for Compose-managed containers)
  const composeService = containerInfo.Labels?.['com.docker.compose.service'];
  if (composeService) return composeService;

  // Priority 2: Parse container name
  const rawName = (containerInfo.Names?.[0] || '').replace(/^\//, '');
  const parts = rawName.split('_');
  // "sockshop_catalogue_1" → ["sockshop", "catalogue", "1"] → "catalogue"
  if (parts.length >= 3) return parts.slice(1, -1).join('-');
  if (parts.length === 2) return parts[1];
  return rawName;
}
```

**The `unknown-XXXX` bug:** Before this priority chain was implemented, containers that weren't Compose-managed (or had unexpected name formats) were assigned `unknown-<containerId[:8]>` as their service name. This polluted the graph with useless ghost nodes and prevented edge correlation. The fix: always try the Compose label first, which is deterministic and always the correct service name.

---

## Node Type Detection

```typescript
function determineType(name: string, image: string): string {
  const n = name.toLowerCase();
  const img = image.toLowerCase();
  if (n.includes('db') || img.includes('mongo') || img.includes('mysql') || img.includes('postgres'))
    return 'database';
  if (n.includes('rabbitmq') || n.includes('queue') || img.includes('rabbitmq'))
    return 'queue';
  if (n.includes('edge-router') || n.includes('gateway') || img.includes('traefik'))
    return 'gateway';
  if (n.includes('front-end') || n.includes('frontend') || n.includes('ui'))
    return 'frontend';
  return 'service';
}
```

Heuristic-based on container name and image name. Works well for Sock Shop and Vertikal. For custom setups, the type can be overridden in a future target adapter.
