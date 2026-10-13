# Troubleshooting & Known Issues

---

## Target Shows "NO DATA"

**Symptom:** Target card shows `NO DATA` status immediately after being added.

**Causes & fixes:**

1. **`data/remote_config.json` is missing or malformed**
   - Check: `cat data/remote_config.json`
   - Fix: Re-add via UI or create the file manually

2. **SSH connection failing**
   - Check: `ssh -i ~/.ssh/key.pem ubuntu@<ip> echo ok`
   - Common issues: Wrong key path, wrong username, security group blocking port 22, key needs chmod 400

3. **`sshKeyPath` has wrong format**
   - `~/` prefix is supported but only expanded server-side
   - Absolute path is safest: `/home/royson/.ssh/mykey.pem`

4. **Key has a passphrase**
   - The server can't handle interactive passphrase prompts
   - Remove passphrase: `ssh-keygen -p -f ~/.ssh/mykey.pem`

---

## Nodes Show 0% CPU or No Metrics

**Symptom:** Nodes exist in the graph but show no metrics or zero values.

**Most likely cause:** ID mismatch between discovery and metric ingestion.

**Diagnosis:**
1. Check `GET /api/diagnostics` — is `nodeCount > 0`?
2. Check server logs for `[INGEST]` lines — is the `targetId` correct?
3. Look at what node IDs exist: `GET /api/targets/:id/services`
4. Check if metric node IDs in the payload match IDs in `nodesByTarget`

**Common root cause:** The remote collector is using a different separator format. The `normalizeId()` function handles most cases but if a completely new format appears (e.g., `sock_shop.catalogue`), it won't match.

**Fix:** Check `remote-collector/index.ts`'s `deriveServiceName()` and ensure it returns `catalogue` (just the service name, no project prefix). The server adds the `${targetId}:` prefix.

---

## Edges Disappear After a Few Minutes

**Symptom:** Edges that were visible disappear without services going offline.

**Cause 1: Stale status reset**
Edges have their status reset if no HTTP metrics arrive in the aggregation window. This is intentional — stale `failed` statuses should clear. But it means edges without log data may appear to "disappear" from the active state view.

**Cause 2: Node pruning cascade**
If either endpoint node was pruned (15+ minutes without `lastSeen` update), its edges are pruned too. Check if the node's `lastSeen` is being updated.

**Cause 3: Target went offline**
If the target transitions to `OFFLINE` and then the session ends, `edgesByTarget` may be cleared during re-registration. Don't delete/re-add the target — use `POST /api/discovery/refresh` instead.

---

## TracesView Shows No Events

**Symptom:** TCP event list is empty or "No trace events available."

**Check list:**
1. Is the remote collector running on EC2? Check with `ps aux | grep node`
2. Are `connectionEvents` being sent? Look for `[TRACES]` in server logs
3. Is `/proc/net/tcp` readable? `ssh ubuntu@<ip> cat /proc/net/tcp | head -5`
4. Is `ipToNameMap` populated? If Docker inspect fails for some containers, their IPs won't resolve and no events are emitted
5. Are both services in the same Docker network? Cross-network TCP won't appear in a single container's `/proc/net/tcp` view

---

## Terminal Doesn't Connect to Remote

**Symptom:** Terminal panel opens but commands hang or error immediately.

**Check list:**
1. `data/remote_config.json` has `ec2PublicIp`, `sshUsername`, `sshKeyPath` for the selected target
2. The SSH key doesn't have a passphrase (interactive passphrase prompts block the child process)
3. `StrictHostKeyChecking=no` is set in the spawn args — host key prompts don't apply
4. The EC2 instance allows inbound SSH (port 22) from your IP

**Testing manually:**
```bash
ssh -tt -F /dev/null -i ~/.ssh/mykey.pem -o StrictHostKeyChecking=no ubuntu@<ip> echo connected
```

If this hangs, the server's terminal will also hang.

---

## ML Scores Not Showing on Nodes

**Symptom:** `node.analytics.anomalyScore` is always undefined.

**Check list:**
1. Does `ml/data/latest_scores.json` exist? `ls -la ml/data/`
2. Are IDs in the scores file canonical? Must be `"sock-shop:catalogue"` not `"sock-shop-catalogue"`
3. Check mtime: `stat ml/data/latest_scores.json` — if not updating, `score.py` may have crashed
4. Check `score.py` logs: `tail -f ml/logs/score.log`

**IDs must match exactly.** If the collector uses `sock-shop-catalogue` but the server normalizes to `sock-shop:catalogue`, the score will never find its node.

---

## High Memory Usage on Server

**Symptom:** Server process memory grows over time.

**Known causes:**
1. **MetricStore not deleting pruned nodes:** Fixed in `pruneStaleNodes()` — calls `metricStore.deleteNode(id)`. If on older code, upgrade.
2. **`edgeActivity` leak:** Fixed — entries now deleted when edges are pruned. If on older code, restart server weekly.
3. **`metrics_raw.csv` is on the server machine:** The ML `collector.py` should run on a separate machine or have file size monitoring.

---

## Nodes Jump Around in the Graph

**Symptom:** Node positions reset every few seconds.

**Cause:** Layout signature computation is broken or position preservation logic isn't working.

**Check:**
1. Open browser DevTools → Console — are there JS errors?
2. Is `useGraphData`'s `sameNodeSet` check evaluating to `true` when it should? Add a `console.log(sameSet)` temporarily.
3. Is a topology change actually happening? If a node briefly disappears and comes back (e.g., during a discovery cycle that misses a container), it gets a new position.

**Normal behavior:** Positions DO change when topology changes (nodes added/removed). This is expected. Only metric updates should preserve positions.

---

## Known Issues

### 1. `edgeActivity` Memory Leak (Fixed in current version)

**Was:** Pruned edges' `edgeActivity` entries were never cleaned up, causing slow memory growth.
**Fixed:** `pruneStaleNodes()` now calls `this.edgeActivity.delete(edgeId)` for pruned edges.
**Version:** Fixed when node pruning was added.

### 2. `clearRuntimeState()` Called on Startup (Fixed)

**Was:** Every server restart wiped `graph_db.json`, requiring all targets to be re-added.
**Fixed:** `clearRuntimeState()` call removed from `server/index.ts` startup sequence.

### 3. Short TCP Connections Missed

**Is:** Connections that open and close within one 5-second polling cycle are invisible.
**Not a bug:** Documented limitation of the `/proc/net/tcp` polling approach.
**Workaround:** None without moving to eBPF or OpenTelemetry instrumentation.

### 4. SSH Channel Exhaustion on Small EC2 Instances

**Is:** On `t2.micro`/`t3.micro` with 15+ containers, SSH channel creation can fail under load, causing telemetry gaps.
**Mitigation:** Separate `adHocConnManager` for log fetches reduces contention. 15-minute node pruning threshold prevents data loss during outages.

### 5. `unknown-XXXX` Node Names (Fixed)

**Was:** Containers without Compose labels were named `unknown-<containerIdSlice>`, creating useless graph nodes.
**Fixed:** `deriveServiceName()` in `remote-collector/index.ts` now uses a priority chain: Compose label first, then name-based parsing.

### Traffic Generator: "Endpoint Unavailable" or "Unreachable" 
If the traffic generator UI blocks the "Start" button and reports targets as UNREACHABLE:
1. **Timeouts**: Remote AWS targets (like OpenTelemetry) may have higher latency (>2-3s). The system's reachability checks timeout if latency is too high. This has been increased from 2s/4s to 10s in `server/api/routes.ts` and `traffic-gen/server.js`.
2. **Port Prioritization**: The UI defaults to the first alphabetical endpoint it discovers. Previously, this caused OpenTelemetry to default to Grafana (`:3000`), which is not externally reachable, blocking traffic. The UI (`TrafficControlPanel.tsx`) now intelligently defaults to common frontend ports (`80`, `8080`, `8000`).
3. **Stub Targets**: Ensure the target is added to `KNOWN_TRAFFIC_GEN_TARGETS` in `TrafficController.ts` and that its traffic-gen workflow has `STUB: false` (unless injecting dynamic endpoints).

