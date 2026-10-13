import type { ServiceNode } from '../models/ServiceNode.js';
import type { DependencyEdge } from '../models/DependencyEdge.js';
import type { BaseCollector } from '../collectors/BaseCollector.js';
import type { DockerCollector } from '../collectors/DockerCollector.js';
import type { Target, TelemetryEnvelope } from '../models/index.js';
import { MetricStore } from '../telemetry/MetricStore.js';
import { config } from '../config.js';
import { EndpointRegistry } from '../registry/EndpointRegistry.js';
import { EndpointDiscoveryEngine } from '../discovery/EndpointDiscoveryEngine.js';
import { TraceStore } from '../traces/TraceStore.js';
import fs from 'fs';
import path from 'path';

import type { WebSocketManager } from '../api/websocket.js';

export class GraphStore {
  // Target Isolation: Maps targetId -> map of ids to models
  public targets = new Map<string, Target>();
  public nodesByTarget = new Map<string, Map<string, ServiceNode>>();
  public edgesByTarget = new Map<string, Map<string, DependencyEdge>>();
  
  public metricStore = new MetricStore();
  public endpointRegistry = new EndpointRegistry();
  public discoveryEngine: EndpointDiscoveryEngine;
  private traceStores = new Map<string, TraceStore>();
  private storagePath: string;
  private saveTimeout: NodeJS.Timeout | null = null;
  private wsManager?: WebSocketManager;
  /** Rolling connection-event counts per edge id, for the activity rate. */
  private edgeActivity = new Map<string, { count: number; windowStart: number }>();

  constructor(wsManager?: WebSocketManager) {
    this.wsManager = wsManager;
    this.storagePath = path.resolve(process.cwd(), 'data', 'graph_db.json');
    this.discoveryEngine = new EndpointDiscoveryEngine(
      this.endpointRegistry,
      this.wsManager,
      (targetId: string) => {
        const target = this.targets.get(targetId);
        return target?.host && target.host !== 'unknown' ? target.host : undefined;
      },
      (targetId: string, services: any[], dependencies: any[]) => {
        this.handleTopologyDiscovered(targetId, services, dependencies);
      },
      (targetId: string, envelope: any) => {
        this.ingestRemote(envelope);
      }
    );

    this.loadFromDisk();
    this.loadTargetsFromConfig();
    
    // Initial discovery for loaded targets
    this.discoveryEngine
      .discoverAll()
      .then(() => this.updateTargetDiscoverySummaries())
      // Without this, a rejection from startup discovery is an unhandled
      // rejection, which terminates the process in Node 18+. Targets being
      // unreachable at boot is normal here, not fatal.
      .catch((e) => console.error('[GraphStore] Initial discovery failed:', e?.message ?? e));
    
    setInterval(() => {
      this.checkTargetStaleness();
      this.pruneStaleNodes();
      this.pingTargetEndpoints();
      this.updateTargetDiscoverySummaries();
      // Broadcast current graph state so UI stays in sync with status changes
      if (this.wsManager) {
        this.wsManager.broadcast('graph-update', this.getGraph());
      }
    }, 10000);
  }

  private loadTargetsFromConfig() {
    const configPath = path.join(process.cwd(), 'data', 'remote_config.json');
    if (fs.existsSync(configPath)) {
      try {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        for (const [targetId, tConf] of Object.entries<any>(configData)) {
          this.registerNewProject(targetId, tConf.displayName || targetId, tConf.ec2PublicIp, tConf.trafficBaseUrl);
        }
      } catch (e) {
        console.error('[GraphStore] Error loading remote_config.json:', e);
      }
    }
  }

  public registerNewProject(targetId: string, displayName: string, hostIp: string, trafficBaseUrl?: string) {
    const nowIso = new Date().toISOString();
    const defaultPort = targetId === 'vertikal' ? 54321 : (targetId === 'open-telemetry' || targetId === 'death-star' ? 8080 : 80);
    let resolvedPort = defaultPort;
    let resolvedBaseUrl = trafficBaseUrl;
    if (resolvedBaseUrl) {
      try {
        const parsed = new URL(resolvedBaseUrl);
        if (parsed.port) resolvedPort = Number(parsed.port);
      } catch {}
    } else if (hostIp && hostIp !== 'unknown') {
      resolvedBaseUrl = `http://${hostIp}:${defaultPort}`;
    }

    this.upsertTarget({
      targetId,
      displayName,
      environment: 'aws',
      host: hostIp || 'unknown',
      transport: 'http',
      status: 'NO DATA',
      lastSeen: nowIso,
      baseUrl: resolvedBaseUrl,
      publicPort: resolvedPort,
      endpointStatus: hostIp && hostIp !== 'unknown' ? 'REACHABLE' : 'UNCONFIGURED',
      capabilities: { dockerMetrics: true, serviceHealth: true, topology: true, httpInteractions: true, traces: false }
    });
    // Trigger discovery immediately (use refresh to ensure new config is picked up)
    this.discoveryEngine
      .refreshTarget(targetId)
      .then(() => this.updateTargetDiscoverySummaries())
      .catch((e) => console.error(`[GraphStore] Discovery failed for ${targetId}:`, e?.message ?? e));
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const data = JSON.parse(raw);
        if (data.targets && typeof data.targets === 'object') {
          for (const [k, v] of Object.entries(data.targets)) {
            this.targets.set(k, v as Target);
          }
        }
        if (data.nodesByTarget && typeof data.nodesByTarget === 'object') {
          const loadTimeIso = new Date().toISOString();
          for (const [tId, nodesObj] of Object.entries(data.nodesByTarget)) {
            const nodesMap = this.getTargetNodes(tId);
            for (const [nId, node] of Object.entries(nodesObj as Record<string, ServiceNode>)) {
              // Nodes saved before `lastSeen` existed (or from a target that
              // isn't reachable this run) get a load-time baseline so
              // pruneStaleNodes() gives them a full grace window to be
              // reconfirmed by a real discovery/telemetry cycle instead of
              // being treated as already-infinitely-stale on the first tick.
              if (!node.lastSeen) node.lastSeen = loadTimeIso;
              nodesMap.set(nId, node);
            }
          }
        }
        if (data.edgesByTarget && typeof data.edgesByTarget === 'object') {
          for (const [tId, edgesObj] of Object.entries(data.edgesByTarget)) {
            const edgesMap = this.getTargetEdges(tId);
            for (const [eId, edge] of Object.entries(edgesObj as Record<string, DependencyEdge>)) {
              edgesMap.set(eId, edge);
            }
          }
        }
        console.log(`[GraphStore] Loaded persistent graph state from disk (${this.targets.size} targets)`);
      }
    } catch (e) {
      console.warn('[GraphStore] Failed to load graph state from disk:', e);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.saveToDisk();
    }, 2000);
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const targetsObj: Record<string, Target> = {};
      for (const [k, v] of this.targets.entries()) targetsObj[k] = v;

      const nodesObj: Record<string, Record<string, ServiceNode>> = {};
      for (const [tId, map] of this.nodesByTarget.entries()) {
        nodesObj[tId] = {};
        for (const [nId, n] of map.entries()) nodesObj[tId][nId] = n;
      }

      const edgesObj: Record<string, Record<string, DependencyEdge>> = {};
      for (const [tId, map] of this.edgesByTarget.entries()) {
        edgesObj[tId] = {};
        for (const [eId, e] of map.entries()) edgesObj[tId][eId] = e;
      }

      const payload = JSON.stringify({ targets: targetsObj, nodesByTarget: nodesObj, edgesByTarget: edgesObj });
      fs.writeFileSync(this.storagePath, payload, 'utf8');
    } catch (e) {
      console.error('[GraphStore] Failed to save graph state to disk:', e);
    }
  }



  private async pingTargetEndpoints() {
    for (const target of this.targets.values()) {
      if (target.baseUrl) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          const res = await fetch(target.baseUrl, { method: 'HEAD', signal: controller.signal }).catch(async () => {
            return await fetch(target.baseUrl!, { method: 'GET', signal: controller.signal });
          });
          clearTimeout(timeoutId);
          if (res && res.status < 500) {
            // A reachable website says nothing about telemetry: it no longer refreshes lastSeen, which made a
            // target with zero collected services show as LIVE. Status comes from telemetry only (see touchTarget).
            target.endpointStatus = 'REACHABLE';
          } else {
            target.endpointStatus = 'UNREACHABLE';
          }
        } catch (e) {
          target.endpointStatus = 'UNREACHABLE';
        }
      } else {
        target.endpointStatus = 'UNCONFIGURED';
      }
    }
  }

  public touchTarget(targetId: string) {
    // Deprecated: Target status must only be updated by genuine telemetry (ingestRemote)
  }

  private checkTargetStaleness() {
    const now = Date.now();
    for (const target of this.targets.values()) {
      if (target.lastSeen) {
        const diff = now - new Date(target.lastSeen).getTime();
        // Wider thresholds: STALE after 2min, OFFLINE after 5min
        if (diff > 300000) target.status = 'OFFLINE';
        else if (diff > 120000) target.status = 'STALE';
        else target.status = 'LIVE';
      } else {
        target.status = 'NO DATA';
      }
    }
  }

  // A container that restarts onto a new container id, or a one-off
  // discovery/metric match failure, used to leave a permanent ghost node
  // behind (e.g. "unknown-<hash>") since nodes were only ever upserted,
  // never removed. Anything not touched by a real discovery or telemetry
  // update in a while is almost certainly gone — drop it, and any edge
  // that pointed at it, rather than let the graph accumulate forever.
  // Deliberately longer than checkTargetStaleness()'s 5min OFFLINE
  // threshold: on these resource-constrained EC2 hosts, SSH channel
  // exhaustion has been observed to black out ALL commands (discovery and
  // telemetry alike) for several minutes at a stretch. Pruning on the same
  // 5min clock as OFFLINE would wipe every node the moment a target goes
  // OFFLINE, even though it typically recovers on its own — so give it
  // extra room to reconnect and reconfirm before treating nodes as gone.
  private static readonly STALE_NODE_MS = 900_000;

  private pruneStaleNodes() {
    const now = Date.now();
    for (const [targetId, nodesMap] of this.nodesByTarget.entries()) {
      const removedIds = new Set<string>();
      for (const [id, node] of nodesMap.entries()) {
        const age = node.lastSeen ? now - new Date(node.lastSeen).getTime() : Infinity;
        if (age > GraphStore.STALE_NODE_MS) {
          nodesMap.delete(id);
          this.metricStore.deleteNode(id);
          removedIds.add(id);
        }
      }
      if (removedIds.size === 0) continue;

      const edgesMap = this.edgesByTarget.get(targetId);
      if (edgesMap) {
        for (const [edgeId, edge] of edgesMap.entries()) {
          if (removedIds.has(edge.source) || removedIds.has(edge.target)) {
            edgesMap.delete(edgeId);
            // The activity counter is keyed by edge id and was never
            // cleaned up, so every pruned edge leaked an entry that grew
            // for the lifetime of the process.
            this.edgeActivity.delete(edgeId);
          }
        }
      }
      console.log(`[GRAPH] target=${targetId} pruned ${removedIds.size} stale node(s): ${[...removedIds].join(', ')}`);
      this.scheduleSave();
    }
  }

  private updateTargetDiscoverySummaries() {
    for (const target of this.targets.values()) {
      this.endpointRegistry.touchDiscovery(target.targetId);
      const summary = this.endpointRegistry.getSummary(target.targetId);
      target.discoverySummary = summary;
    }
  }

  private getTargetNodes(targetId: string) {
    if (!this.nodesByTarget.has(targetId)) {
      this.nodesByTarget.set(targetId, new Map());
    }
    return this.nodesByTarget.get(targetId)!;
  }

  private getTargetEdges(targetId: string) {
    if (!this.edgesByTarget.has(targetId)) {
      this.edgesByTarget.set(targetId, new Map());
    }
    return this.edgesByTarget.get(targetId)!;
  }

  private upsertTarget(target: Target) {
    const existing = this.targets.get(target.targetId);
    if (existing) {
      existing.status = target.status;
      existing.lastSeen = target.lastSeen;
      if (target.host && target.host !== 'unknown') existing.host = target.host;
      if (target.baseUrl) existing.baseUrl = target.baseUrl;
      if (target.endpointStatus) existing.endpointStatus = target.endpointStatus;
      if (target.capabilities) existing.capabilities = { ...existing.capabilities, ...target.capabilities };
    } else {
      this.targets.set(target.targetId, target);
    }
    this.scheduleSave();
  }

  private handleTopologyDiscovered(targetId: string, services: any[], dependencies: any[]) {
    const nodesMap = this.getTargetNodes(targetId);
    const edgesMap = this.getTargetEdges(targetId);

    // Update target lastSeen so it stays LIVE, but only when discovery actually found services:
    // an empty discovery is "no data", not a sign of life.
    const target = this.targets.get(targetId);
    const found = services.filter(s => !String(s?.name ?? '').includes('mapper-collector')).length;
    if (target && found > 0) {
      target.lastSeen = new Date().toISOString();
      target.status = 'LIVE';
    }

    for (const svc of services) {
      if (svc.name.includes('mapper-collector')) continue;
      const nodeId = svc.serviceId;
      const existing = nodesMap.get(nodeId);
      
      const st = String(svc.state ?? 'unknown');
      const status = st === 'running' ? 'healthy' : ['exited', 'dead', 'paused'].includes(st) ? 'critical' : st === 'restarting' ? 'degraded' : 'unknown';
      const nodeType = ['gateway', 'service', 'database', 'queue', 'frontend', 'infrastructure', 'external'].includes(svc.type) ? svc.type : 'service';
      
      const nowIso = new Date().toISOString();
      if (existing) {
        existing.status = status as any;
        existing.type = nodeType as any;
        existing.lastSeen = nowIso;
        existing.metadata = {
          ...existing.metadata,
          state: st,
          vanished: false,
          ...(svc.containerName ? { containerName: svc.containerName } : {}),
          containerId: svc.containerId,
          image: svc.image,
          ports: svc.ports.map((p: any) => p.containerPort.toString())
        };
      } else {
        nodesMap.set(nodeId, {
          id: nodeId,
          name: svc.name,
          type: nodeType as any,
          project: targetId,
          status: status as any,
          lastSeen: nowIso,
          metadata: {
            state: st,
            ...(svc.containerName ? { containerName: svc.containerName } : {}),
            containerId: svc.containerId,
            image: svc.image,
            ports: svc.ports.map((p: any) => p.containerPort.toString())
          },
          metrics: null
        });
      }
    }

    for (const dep of dependencies) {
      const edgeId = `${dep.sourceServiceId}->${dep.targetServiceId}`;
      const existing = edgesMap.get(edgeId);
      if (existing) {
        existing.declared = existing.declared || dep.declared === true;
        existing.observed = existing.observed || dep.observed;
        for (const src of dep.evidenceSources) {
          if (!existing.evidenceSources.includes(src)) {
            existing.evidenceSources.push(src);
          }
        }
      } else {
        edgesMap.set(edgeId, {
          id: edgeId,
          source: dep.sourceServiceId,
          target: dep.targetServiceId,
          type: 'dependency',
          declared: dep.declared === true,
          observed: dep.observed,
          evidenceSources: dep.evidenceSources || [],
          status: dep.observed ? 'active' : 'unknown',
          metrics: null
        });
      }
    }

    console.log(`[GRAPH] target=${targetId} services=${nodesMap.size} edges=${edgesMap.size}`);

    this.scheduleSave();
    if (this.wsManager) {
      this.wsManager.broadcast('graph-update', this.getGraph());
    }
  }



  private anomalyScoresCache: { mtimeMs: number; data: Record<string, any> } | null = null;

  /** Reads ml/score.py's output file, re-reading only when it changes on
   * disk. Missing file (no models trained yet) is not an error — just no
   * scores to attach. */
  private readAnomalyScores(): Record<string, any> {
    const scoresPath = path.resolve(process.cwd(), '..', 'core', 'ml', 'data', 'latest_scores.json');
    try {
      const stat = fs.statSync(scoresPath);
      if (this.anomalyScoresCache?.mtimeMs === stat.mtimeMs) {
        return this.anomalyScoresCache.data;
      }
      const data = JSON.parse(fs.readFileSync(scoresPath, 'utf8'));
      this.anomalyScoresCache = { mtimeMs: stat.mtimeMs, data };
      return data;
    } catch {
      return {};
    }
  }

  getGraph(): { nodes: ServiceNode[], edges: DependencyEdge[], targets: Target[] } {
    const allNodes: ServiceNode[] = [];
    const allEdges: DependencyEdge[] = [];

    for (const nodesMap of this.nodesByTarget.values()) {
      allNodes.push(...Array.from(nodesMap.values()));
    }

    for (const edgesMap of this.edgesByTarget.values()) {
      allEdges.push(...Array.from(edgesMap.values()));
    }

    const scores = this.readAnomalyScores();
    for (const node of allNodes) {
      const s = scores[node.id];
      if (s) {
        node.analytics = { ...node.analytics, anomalyScore: s.anomaly_score, anomalyPersistent: s.persistent };
      }
    }

    this.applyEdgeActivity(allEdges);

    return { nodes: allNodes, edges: allEdges, targets: Array.from(this.targets.values()) };
  }

  /**
   * Turns the rolling connection counts into a per-minute rate. The window
   * resets once it has run long enough to be meaningful, so the figure
   * tracks current activity instead of drifting toward a lifetime average.
   * Edges with no observations are left without an `activity` field rather
   * than being given a zero — "never seen" and "measured as idle" are
   * different claims.
   */
  private applyEdgeActivity(edges: DependencyEdge[]): void {
    const now = Date.now();
    const WINDOW_RESET_MS = 120_000;

    for (const edge of edges) {
      const bucket = this.edgeActivity.get(edge.id);
      if (!bucket) continue;

      const elapsedMs = Math.max(1000, now - bucket.windowStart);
      const perMin = (bucket.count / elapsedMs) * 60_000;
      edge.activity = {
        samplesPerMin: Math.round(perMin * 10) / 10,
        windowSec: Math.round(elapsedMs / 1000),
        lastSeen: new Date().toISOString(),
      };

      if (elapsedMs > WINDOW_RESET_MS) {
        // Carry half the count forward so the rate decays instead of
        // snapping to zero the instant a window rolls over.
        this.edgeActivity.set(edge.id, { count: Math.floor(bucket.count / 2), windowStart: now - WINDOW_RESET_MS / 2 });
      }
    }
  }

  getNode(id: string): ServiceNode | undefined {
    for (const nodesMap of this.nodesByTarget.values()) {
      if (nodesMap.has(id)) return nodesMap.get(id);
    }
    return undefined;
  }

  ingestRemote(payload: TelemetryEnvelope, clientIp?: string) {
    const { targetId, events } = payload;
    console.log(`[TELEMETRY] target=${targetId} nodes=${events.nodes?.length || 0} metrics=${events.metrics?.length || 0} edges=${events.edges?.length || 0} interactions=${events.interactions?.length || 0}`);
    const cleanClientIp = clientIp ? clientIp.replace(/^.*:/, '') : undefined;
    const remoteHost = (cleanClientIp && cleanClientIp !== '127.0.0.1') ? cleanClientIp : 'unknown';

    const existingTarget = this.targets.get(targetId);
    const defaultPort = targetId === 'vertikal' ? 54321 : (targetId === 'open-telemetry' || targetId === 'death-star' ? 8080 : 80);
    const port = existingTarget?.publicPort || defaultPort;
    const hostToUse = (existingTarget?.host && existingTarget.host !== 'unknown') ? existingTarget.host : remoteHost;

    this.upsertTarget({
      targetId,
      displayName: targetId === 'sock-shop' ? 'Sock Shop AWS' : (targetId === 'vertikal' ? 'Vertikal AWS' : targetId),
      environment: 'remote',
      host: hostToUse,
      transport: 'http',
      status: 'LIVE',
      lastSeen: new Date().toISOString(),
      baseUrl: hostToUse !== 'unknown' ? `http://${hostToUse}:${port}` : existingTarget?.baseUrl,
      capabilities: { dockerMetrics: true, serviceHealth: true, topology: true, httpInteractions: true, traces: true }
    });

    const nodesMap = this.getTargetNodes(targetId);
    const edgesMap = this.getTargetEdges(targetId);
    
    const normalizeId = (rawId: string) => {
      if (!rawId || rawId === 'external' || rawId === 'unknown-upstream') return rawId;
      const clean = rawId.replace(new RegExp(`^${targetId}[-:/]`), '');
      return `${targetId}:${clean}`;
    };

    if (events.nodes) {
      const nowIso = new Date().toISOString();
      for (const node of events.nodes) {
        if (!node.project) node.project = targetId;
        node.id = normalizeId(node.id);
        // Tier 1/2 request metrics ride along on the envelope when a source
        // produced them. Merged rather than assigned, so a cycle where the
        // optional source was unavailable does not wipe the resource metrics
        // the agentless path collected in the same cycle.
        const req = (node as any).requestMetrics;
        delete (node as any).requestMetrics;

        const existing = nodesMap.get(node.id);
        if (existing) {
          existing.status = node.status;
          existing.lastSeen = nowIso;
          if (node.metadata) existing.metadata = { ...existing.metadata, ...node.metadata };
          if (req) {
            existing.metrics = { ...(existing.metrics ?? {}), ...req } as any;
          }
        } else {
          node.lastSeen = nowIso;
          if (req) node.metrics = { ...(node.metrics ?? {}), ...req };
          nodesMap.set(node.id, node);
        }
      }
    }
    
    if (events.edges) {
      for (const edge of events.edges) {
        edge.source = normalizeId(edge.source);
        edge.target = normalizeId(edge.target);
        edge.id = `${edge.source}->${edge.target}`;
        const existing = edgesMap.get(edge.id);
        if (!edge.observed) {
          if (!existing) edgesMap.set(edge.id, edge);
          continue;
        }
        if (existing) {
          existing.observed = edge.observed || existing.observed;
          existing.declared = edge.declared || existing.declared;
          existing.protocol = edge.protocol || existing.protocol;
          existing.lastSeen = edge.lastSeen || new Date().toISOString();
          for (const source of edge.evidenceSources) {
            if (!existing.evidenceSources.includes(source)) {
              existing.evidenceSources.push(source);
            }
          }
          if (edge.status !== 'unknown') existing.status = edge.status;
          if (!existing.observed) {
            existing.observed = true;
            console.log(`[EDGE] target=${targetId} source=${existing.source} target=${existing.target} observed=true`);
          }
        } else {
          edgesMap.set(edge.id, edge);
          console.log(`[EDGE] target=${targetId} source=${edge.source} target=${edge.target} observed=true`);
        }
      }
    }
    
    if (events.metrics) {
      for (const m of events.metrics) {
        const normNodeId = normalizeId(m.nodeId);
        this.metricStore.push(normNodeId, m.snapshot);
        const node = nodesMap.get(normNodeId);
        if (node) {
          node.metrics = {
            cpu: m.snapshot.cpu !== undefined ? Math.round(m.snapshot.cpu * 10) / 10 : 0,
            memory: m.snapshot.memory || 0,
            memoryPercent: m.snapshot.memoryPercent !== undefined ? Math.round(m.snapshot.memoryPercent * 10) / 10 : 0,
            networkRx: m.snapshot.networkRx || 0,
            networkTx: m.snapshot.networkTx || 0,
            latency: null,
            requestRate: null,
            errorRate: null,
          };
        }
      }
    }
    
    if (events.interactions) {
      for (const e of events.interactions) {
        e.source = normalizeId(e.source);
        e.target = normalizeId(e.target);
        e.latencyMs = e.latencyMs ?? e.latency ?? null;
        e.statusCode = e.statusCode ?? null;
        e.bytesSent = e.bytesSent ?? null;
        e.bytesReceived = e.bytesReceived ?? null;
        e.success = e.success ?? (e.statusCode === null ? null : e.statusCode < 400);
        this.metricStore.pushEvent(e);

        console.log(`[INTERACTION] target=${targetId} source=${e.source} target=${e.target} protocol=${e.protocol ?? 'unknown'} method=${e.method ?? 'unknown'} route=${e.route ?? 'unknown'} evidence=${e.evidenceSource}`);

        if (e.source !== e.target && e.source !== 'external' && e.source !== 'unknown-upstream') {
          const edgeId = `${e.source}->${e.target}`;
          const existing = edgesMap.get(edgeId);
          if (existing) {
            const wasObserved = existing.observed;
            existing.observed = true;
            existing.protocol = e.protocol || existing.protocol;
            existing.lastSeen = e.timestamp;
            if (!existing.evidenceSources.includes('http-log')) {
              existing.evidenceSources.push('http-log');
            }
            if (!wasObserved) {
              console.log(`[EDGE] target=${targetId} source=${existing.source} target=${existing.target} observed=true`);
            }
          } else {
            edgesMap.set(edgeId, {
              id: edgeId,
              source: e.source,
              target: e.target,
              type: e.protocol === 'amqp' || e.protocol === 'rabbitmq' ? 'message' : 'http',
              declared: false,
              observed: true,
              evidenceSources: ['http-log'],
              firstSeen: e.timestamp,
              lastSeen: e.timestamp,
              status: 'active',
              metrics: null,
            });
            console.log(`[EDGE] target=${targetId} source=${e.source} target=${e.target} observed=true`);
          }
        }

        const eventRoute = e.route;
        if (eventRoute) {
          const matchedRoute = this.endpointRegistry.getRoutes(targetId).find(r => r.path === eventRoute || eventRoute.startsWith(r.path));
          if (matchedRoute) {
            this.endpointRegistry.markRouteObserved(
              targetId,
              matchedRoute.routeId,
              e.latencyMs ?? e.latency ?? undefined,
              e.statusCode !== null && e.statusCode !== undefined ? e.statusCode >= 400 : false,
            );
          }
        }
      }
    }

    // Ingest raw connection events for the Traces feature
    if (events.connectionEvents && events.connectionEvents.length > 0) {
      const traceStore = this.getTraceStore(targetId);
      traceStore.saveEvents(events.connectionEvents).catch(err => {
        console.error(`[TRACES] Failed to save connection events for ${targetId}:`, err);
      });
      // Broadcast connection events to WebSocket for real-time Traces UI
      if (this.wsManager) {
        this.wsManager.broadcast('trace-events', {
          targetId,
          events: events.connectionEvents
        });
      }
      console.log(`[TRACES] target=${targetId} connectionEvents=${events.connectionEvents.length}`);

      // Roll up per-edge connection activity. This is the only real
      // measure of how busy a link is — edge.metrics (latency, errors,
      // request rate) is null for every edge here because nothing collects
      // HTTP-level data, so activity is what the heat scale can honestly
      // be driven by.
      for (const ev of events.connectionEvents) {
        const src = normalizeId(ev.sourceServiceId);
        const dst = normalizeId(ev.destServiceId);
        if (!src || !dst || src === dst) continue;
        const key = `${src}->${dst}`;
        const bucket = this.edgeActivity.get(key) ?? { count: 0, windowStart: Date.now() };
        bucket.count += 1;
        this.edgeActivity.set(key, bucket);
      }
    }
    
    // Edge status/color comes only from evidence measured on that edge
    // (below) — an overloaded node shows its own stress on its own card,
    // it doesn't get smeared onto every edge touching it, since we have no
    // actual latency/error data for most of those edges.
    for (const edge of edgesMap.values()) {
      const edgeMetrics = this.metricStore.getAggregatedEdgeMetrics(edge.source, edge.target);
      if (edgeMetrics && edgeMetrics.requestCount > 0) {
        edge.observed = true;
        if (!edge.evidenceSources.includes('http-log')) {
          edge.evidenceSources.push('http-log');
        }
        edge.metrics = edgeMetrics;
        if (edgeMetrics.errorRate > 0.05) {
          edge.status = 'failed';
        } else if (edgeMetrics.latency !== null && edgeMetrics.latency > 500) {
          edge.status = 'degraded';
        } else {
          edge.status = 'active';
        }
      } else if (edge.status === 'degraded' || edge.status === 'failed') {
        // no current edge-level evidence to justify this — don't leave a
        // stale bad status sitting there forever
        edge.status = edge.observed ? 'active' : 'unknown';
      }
    }

    this.updateTargetDiscoverySummaries();
    this.scheduleSave();
    if (this.wsManager) {
      this.wsManager.broadcast('graph-update', this.getGraph());
    }
  }

  /** Get or create a TraceStore for a target. Used by TraceRouter and ingestRemote. */
  getTraceStore(targetId: string): TraceStore {
    let store = this.traceStores.get(targetId);
    if (!store) {
      store = new TraceStore(targetId);
      this.traceStores.set(targetId, store);
    }
    return store;
  }
}