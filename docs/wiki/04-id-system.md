# ID System — Canonical Node & Edge IDs

## The Problem

The same service is described with different string formats by different subsystems:

| Source | Format example | Problem |
|---|---|---|
| Docker Compose parser | `sock-shop-catalogue` | Uses hyphen as separator |
| Container name | `sockshop_catalogue_1` | Includes project prefix + replica suffix |
| Compose label | `catalogue` | No project prefix at all |
| Remote collector | `sock-shop:catalogue` | Target-prefixed (desired format) |
| Legacy telemetry | `sock-shop/catalogue` | Slash separator (old format) |

Without normalization: `GraphStore` receives a `MetricSnapshot` for `sockshop_catalogue_1` but the node was created with ID `sock-shop:catalogue`. The metric doesn't attach. The node shows no CPU. The edge for `sock-shop:front-end->sock-shop:catalogue` can't be matched against an event tagged `sockshop_front-end_1->sockshop_catalogue_1`. Result: ghost nodes, missing metrics, broken graph.

## The Solution

**Canonical format:** `${targetId}:${serviceName}` — colon separator, no project prefix repetition in the service name.

Examples:
- `sock-shop:catalogue`
- `sock-shop:front-end`
- `sock-shop:catalogue-db`
- `vertikal:market-data`

## `normalizeId()` in `ingestRemote()`

The function is defined inline inside `ingestRemote()` so it closes over `targetId`:

```typescript
const normalizeId = (rawId: string): string => {
  if (!rawId) return rawId;
  // Sentinel values — never normalize these
  if (rawId === 'external' || rawId === 'unknown-upstream') return rawId;

  // Already in canonical form — fast path
  if (rawId.startsWith(`${targetId}:`)) return rawId;

  // Strip any existing targetId prefix with any separator
  const prefixPattern = new RegExp(`^${targetId}[-:/]`);
  const clean = rawId.replace(prefixPattern, '');

  return `${targetId}:${clean}`;
};
```

This handles:
- `sock-shop-catalogue` → `sock-shop:catalogue` (hyphen separator)
- `sock-shop/catalogue` → `sock-shop:catalogue` (slash separator)
- `catalogue` → `sock-shop:catalogue` (no prefix)
- `sock-shop:catalogue` → `sock-shop:catalogue` (already canonical, fast path)

## Edge IDs

```typescript
// Always derived from canonical node IDs:
const edgeId = `${sourceNodeId}->${targetNodeId}`;

// Example:
"sock-shop:front-end->sock-shop:catalogue"
```

Edge IDs are deterministic and stable — given the same source and target, you always get the same edge ID. This means:
- Merge operations are O(1) (just check `edgesMap.has(edgeId)`)
- No UUID generation needed for edges
- Edge deduplication is automatic

## Route IDs (EndpointRegistry)

```typescript
const routeId = `${targetId}:${service}/http-${port}/${method}${path}`;

// Example:
"sock-shop:front-end/http-80/GET/catalogue"
"sock-shop:front-end/http-80/POST/orders"
```

Used internally by `EndpointRegistry` for per-route HTTP observability tracking. Not exposed in the public graph API.

## Sentinel Values

| Value | Meaning | How treated |
|---|---|---|
| `external` | Traffic from outside the cluster (no matching container IP) | Allowed in `source` of interactions; no edge created |
| `unknown-upstream` | Service recognized but upstream can't be resolved | Allowed in `source`; no edge created |

These are intentionally not normalized — they represent "the traffic exists but we can't attribute it to a specific service."

## Service Name Derivation (remote-collector)

The collector derives canonical service names before the normalization step is even needed:

```typescript
function deriveServiceName(containerInfo: any): string {
  // Priority 1: Docker Compose label — always set by `docker-compose up`
  const composeService = containerInfo.Labels?.['com.docker.compose.service'];
  if (composeService) return composeService;

  // Priority 2: Parse container name
  const rawName = (containerInfo.Names?.[0] || '').replace(/^\//, '');
  // Strip compose project prefix (everything up to first _)
  // Strip replica suffix (trailing _1, _2, etc.)
  // "sockshop_catalogue_1" → ["sockshop", "catalogue", "1"] → "catalogue"
  const parts = rawName.split('_');
  if (parts.length >= 3) return parts.slice(1, -1).join('-');
  if (parts.length === 2) return parts[1];
  return rawName;
}
```

**Why Priority 1?** Docker Compose always sets `com.docker.compose.service` to the key name in the `services:` block of the Compose file. This is exactly the canonical service name — no parsing needed. The name-splitting logic in Priority 2 handles non-Compose containers (manually started with `docker run`).
