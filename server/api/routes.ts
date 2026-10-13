import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { pythonCmd, IS_WINDOWS } from '../util/platform.js';
import { GraphStore } from '../graph/GraphStore.js';
import { GraphAnalytics } from '../graph/GraphAnalytics.js';
import type { TelemetryEnvelope } from '../models/index.js';
import { createTraceRouter } from '../traces/TraceRouter.js';

import type { WebSocketManager } from './websocket.js';
import type { IncidentManager } from '../rca/IncidentManager.js';
import type { TrafficController } from '../traffic/TrafficController.js';
import type { ExperimentManager } from '../traffic/ExperimentManager.js';
import { loadThresholds, saveThresholds, thresholdLimits, DEFAULT_THRESHOLDS, THRESHOLD_DOCS } from '../rca/thresholds.js';
import { tailCsvLines, readCsvHeader, fieldAt } from '../util/tailCsv.js';
import { coreAnalysis, coreProxy } from '../rca/CoreBridge.js';

/**
 * Normalises the load knobs that arrive from the UI as strings or nulls.
 *
 * Every field is optional and an absent/invalid one is dropped entirely
 * rather than coerced to 0 — traffic-gen falls back to the workflow
 * profile's own default when a field is missing, and a literal 0 would be
 * rejected by engine.validateConfig ("users must be a positive integer").
 */
function coerceLoad(raw: { users?: unknown; maxConcurrency?: unknown; durationSec?: unknown; endpointPaths?: unknown }) {
  const out: { users?: number; maxConcurrency?: number; durationSec?: number; endpointPaths?: string[] } = {};
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  };
  const users = num(raw.users);
  if (users !== undefined) out.users = users;
  const conc = num(raw.maxConcurrency);
  if (conc !== undefined) out.maxConcurrency = conc;
  const dur = num(raw.durationSec);
  if (dur !== undefined) out.durationSec = dur;
  if (Array.isArray(raw.endpointPaths)) {
    const paths = raw.endpointPaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
    if (paths.length > 0) out.endpointPaths = paths;
  }
  return out;
}

export function createRouter(graphStore: GraphStore, wsManager?: WebSocketManager, incidentManager?: IncidentManager, trafficController?: TrafficController, experimentManager?: ExperimentManager) {
  const router = Router();
  const analytics = new GraphAnalytics(graphStore);

  router.use('/traces', createTraceRouter(graphStore, wsManager));

  router.get('/graph', (_req, res) => {
    res.json(graphStore.getGraph());
  });

  router.get('/nodes/:id', (req, res) => {
    const node = graphStore.getNode(req.params.id);
    if (node) res.json(node);
    else res.status(404).json({ error: 'Node not found' });
  });

  router.get('/nodes/:id/metrics', (req, res) => {
    const range = (req.query.range as string) || '5m';
    const history = graphStore.metricStore.getHistory(req.params.id, range);
    res.json(history);
  });

  /**
   * The "raw traffic logs" feed.
   *
   * Two different things can count as observed traffic here and only one of
   * them usually exists:
   *
   *   HTTP interactions — method, route, status, latency — parsed out of
   *   container access logs. Richest, but it needs a service that actually
   *   writes a parseable access log to stdout. DeathStarBench's nginx-thrift
   *   does not, and sock-shop's edge-router does not either, so this feed was
   *   permanently empty on those targets and the panel just said "waiting for
   *   traffic events" forever while traffic was plainly flowing.
   *
   *   Socket connections — who talked to whom, on which port — observed by
   *   the /proc/net/tcp scanner. Coarser (no route, no status) but it exists
   *   for every target, because it needs nothing of the application.
   *
   * So: prefer interactions, fall back to connections, and say which one is
   * being returned rather than silently showing an empty box. `kind` lets the
   * UI label what it is displaying instead of implying HTTP detail it does
   * not have.
   */
  router.get('/traffic', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
    const targetId = typeof req.query.targetId === 'string' && req.query.targetId !== 'ALL'
      ? req.query.targetId
      : undefined;

    const interactions = graphStore.metricStore.getEvents(limit * 4)
      .filter((e: any) => !targetId || String(e.source ?? '').startsWith(`${targetId}:`) || String(e.target ?? '').startsWith(`${targetId}:`))
      .slice(0, limit);

    if (interactions.length > 0) {
      return res.json({ kind: 'http', events: interactions });
    }

    // Fall back to observed socket connections.
    const targetIds = targetId
      ? [targetId]
      : Array.from(graphStore.targets.keys());
    const connections: any[] = [];
    for (const tid of targetIds) {
      const store = graphStore.getTraceStore?.(tid);
      if (!store) continue;
      for (const ev of store.getRecentEvents(limit)) {
        connections.push({
          timestamp: ev.timestamp,
          source: ev.sourceServiceId,
          target: ev.destServiceId,
          // Deliberately not faking an HTTP status: the scanner sees a
          // socket, not a response. The UI renders these as TCP.
          statusCode: null,
          method: null,
          route: ev.destPort ? `:${ev.destPort} ${ev.state ?? ''}`.trim() : (ev.state ?? null),
          protocol: 'tcp',
          evidenceSource: 'network-tcp',
        });
      }
    }
    connections.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    res.json({ kind: 'connection', events: connections.slice(0, limit) });
  });

  router.get('/analytics', (_req, res) => {
    res.json(analytics.getAnalytics());
  });


  router.get('/diagnostics', (_req, res) => {
    const targets = Array.from(graphStore.targets.values());
    const diagnostics = targets.map(target => {
      const nodes = graphStore.nodesByTarget.get(target.targetId);
      const edges = graphStore.edgesByTarget.get(target.targetId);
      return {
        ...target,
        nodeCount: nodes ? nodes.size : 0,
        edgeCount: edges ? edges.size : 0,
      };
    });
    res.json(diagnostics);
  });

  router.get('/targets', (_req, res) => {
    res.json(Array.from(graphStore.targets.values()));
  });

  router.get('/targets/:targetId/diagnostics', (req, res) => {
    const target = graphStore.targets.get(req.params.targetId);
    if (!target) return res.status(404).json({ error: 'Target not found' });
    const nodes = graphStore.nodesByTarget.get(target.targetId);
    const edges = graphStore.edgesByTarget.get(target.targetId);
    res.json({
      ...target,
      nodeCount: nodes ? nodes.size : 0,
      edgeCount: edges ? edges.size : 0,
    });
  });

  // --- ENDPOINT DISCOVERY & SERVICE REGISTRY API ENDPOINTS ---
  router.get('/targets/:targetId/discovery', (req, res) => {
    const summary = graphStore.endpointRegistry.getSummary(req.params.targetId);
    res.json(summary);
  });

  router.get('/targets/:targetId/services', (req, res) => {
    const services = graphStore.endpointRegistry.getServices(req.params.targetId);
    res.json(services);
  });

  router.get('/nodes/:id/logs', async (req, res) => {
    const nodeId = req.params.id;
    const tail = Math.min(parseInt(req.query.tail as string, 10) || 200, 2000);
    const [targetId] = nodeId.split(':');
    const nodesMap = graphStore.nodesByTarget.get(targetId);
    const node = nodesMap?.get(nodeId);
    const containerId = node?.metadata?.containerId;
    if (!containerId) {
      return res.status(404).json({ error: `No container ID known for node ${nodeId}` });
    }
    try {
      const lines = await graphStore.discoveryEngine.getServiceLogs(targetId, containerId, tail);
      res.json({ nodeId, containerId, tail, lines });
    } catch (e: any) {
      res.status(502).json({ error: e.message ?? 'Failed to fetch logs' });
    }
  });

  router.get('/targets/:targetId/endpoints', (req, res) => {
    const publicOnly = req.query.publicOnly === 'true';
    const endpoints = graphStore.endpointRegistry.getEndpoints(req.params.targetId, publicOnly);
    res.json(endpoints);
  });

  router.get('/targets/:targetId/routes', (req, res) => {
    const serviceId = req.query.serviceId as string;
    const endpointId = req.query.endpointId as string;
    const routes = graphStore.endpointRegistry.getRoutes(req.params.targetId, serviceId, endpointId);
    res.json(routes);
  });

  router.post('/discovery/refresh', async (req, res) => {
    const { targetId } = req.body || {};
    if (targetId) {
      await graphStore.discoveryEngine.refreshTarget(targetId);
    } else {
      await graphStore.discoveryEngine.discoverAll();
    }
    res.json({ success: true, message: 'Discovery refreshed' });
  });


  // Evaluation evidence (bench table, real-crash replay) and core health, served by the Python core.
  router.get(/^\/core(\/.*)?$/, async (req, res) => {
    const [status, body] = await coreProxy((req.params as any)[0] ?? '');
    res.status(status).json(body);
  });

  // --- RCA INCIDENT API ENDPOINTS ---
  router.get('/incidents', async (req, res) => {
    const targetId = req.query.targetId as string;
    // The core (Python, measured algorithms) answers when it can judge the target; otherwise the rule-based manager below does.
    const core = await coreAnalysis();
    if (core && (targetId ? core.ready[targetId] : Object.values(core.ready).some(Boolean))) {
      return res.json(targetId ? core.incidents.filter(i => i.targetId === targetId) : core.incidents);
    }
    if (!incidentManager) return res.json([]);
    if (targetId) {
      const incident = incidentManager.getIncidentForTarget(targetId);
      return res.json(incident ? [incident] : []);
    }
    res.json(incidentManager.getAllActiveIncidents());
  });

  // Registered before /incidents/:id — otherwise Express matches
  // "thresholds" as an incident id and this never runs.
  /**
   * The rules that decide what becomes an incident, plus what each one means.
   *
   * Incidents are rule-based on purpose and share no code with the ML
   * pipeline: they must fire on a service discovered a minute ago, on a
   * target whose models were never trained, while the scorer is stopped.
   * Model output is a separate question and lives under Findings.
   */
  router.get('/incidents/thresholds', (_req, res) => {
    res.json({
      values: loadThresholds(),
      defaults: DEFAULT_THRESHOLDS,
      limits: thresholdLimits(),
      docs: THRESHOLD_DOCS,
    });
  });

  router.post('/incidents/thresholds', (req, res) => {
    try {
      // `reset` puts every rule back rather than making the caller remember
      // ten defaults to send.
      const next = req.body?.reset === true ? saveThresholds(DEFAULT_THRESHOLDS) : saveThresholds(req.body || {});
      res.json({ success: true, values: next });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? 'Could not save thresholds' });
    }
  });

  router.get('/incidents/:id', (req, res) => {
    if (!incidentManager) return res.status(404).json({ error: 'Incident not found' });
    const all = incidentManager.getAllActiveIncidents();
    const incident = all.find(i => i.id === req.params.id);
    if (incident) res.json(incident);
    else res.status(404).json({ error: 'Incident not found' });
  });

  router.get('/incidents/:id/timeline', (req, res) => {
    if (!incidentManager) return res.status(404).json({ error: 'Incident not found' });
    const all = incidentManager.getAllActiveIncidents();
    const incident = all.find(i => i.id === req.params.id);
    if (incident) {
      res.json(incident.anomalies || []);
    } else {
      res.status(404).json({ error: 'Incident not found' });
    }
  });

  router.get('/incidents/:id/evidence', (req, res) => {
    if (!incidentManager) return res.status(404).json({ error: 'Incident not found' });
    const all = incidentManager.getAllActiveIncidents();
    const incident = all.find(i => i.id === req.params.id);
    if (incident) {
      res.json(incident.evidence || []);
    } else {
      res.status(404).json({ error: 'Incident not found' });
    }
  });

  router.get('/incidents/:id/propagation', (req, res) => {
    if (!incidentManager) return res.status(404).json({ error: 'Incident not found' });
    const all = incidentManager.getAllActiveIncidents();
    const incident = all.find(i => i.id === req.params.id);
    if (incident) {
      res.json(incident.propagation || []);
    } else {
      res.status(404).json({ error: 'Incident not found' });
    }
  });

  router.get('/services/:id/anomalies', (req, res) => {
    if (!incidentManager) return res.json([]);
    const all = incidentManager.getAllActiveIncidents();
    const anomalies = all.flatMap(i => i.anomalies.filter(a => a.nodeId === req.params.id));
    res.json(anomalies);
  });

  router.get('/targets/:targetId/resolved-url', (req, res) => {
    const endpointId = req.query.endpointId as string;
    const resolvedUrl = trafficController ? trafficController.resolveBaseUrl(req.params.targetId, endpointId) : null;
    res.json({
      targetId: req.params.targetId,
      endpointId,
      resolvedUrl,
      isConfigured: !!resolvedUrl
    });
  });

  router.get('/targets/:targetId/reachability', async (req, res) => {
    const url = req.query.url as string;
    if (!url) return res.json({ status: 'ERROR', message: 'No URL provided' });
    try {
      const controller = new AbortController();
      // [AGY] Increased timeout from 2000ms to 10000ms. High-latency instances
      // (like open-telemetry) were timing out during UI reachability checks.
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const reachRes = await fetch(url, { method: 'HEAD', signal: controller.signal as any }).catch(() => fetch(url, { method: 'GET', signal: controller.signal as any }));
      clearTimeout(timeoutId);
      if (reachRes) {
        res.json({ status: 'REACHABLE' });
      } else {
        res.json({ status: 'UNREACHABLE' });
      }
    } catch (e: any) {
      if (e.name === 'AbortError') {
        res.json({ status: 'TIMEOUT' });
      } else {
        res.json({ status: 'ERROR', message: e.message });
      }
    }
  });

  router.post('/ingest', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${process.env.INGEST_TOKEN || 'mapper-secret-token'}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
      const payload = req.body as TelemetryEnvelope;
      if (!payload.targetId || !payload.schemaVersion) {
        return res.status(400).json({ error: 'Invalid TelemetryEnvelope schema' });
      }
      
      let clientIp = (payload as any).hostIp;
      if (!clientIp || clientIp === 'unknown') {
        clientIp = (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || '').replace(/^.*:/, '');
      }
      // Safety fallback for SSH tunnels overriding remote address
      if (clientIp === '127.0.0.1' || clientIp === '::1') {
         if (process.env.AWS_EC2_PUBLIC_IP) clientIp = process.env.AWS_EC2_PUBLIC_IP;
      }
      
      graphStore.ingestRemote(payload, clientIp);
      if (wsManager) {
        wsManager.broadcast('graph-update', graphStore.getGraph());
      }
      console.log(`[TELEMETRY] targetId=${payload.targetId} nodes=${payload.events?.nodes?.length || 0} metrics=${payload.events?.metrics?.length || 0} edges=${payload.events?.edges?.length || 0} interactions=${payload.events?.interactions?.length || 0} clientIp=${clientIp}`);
      res.json({ success: true, message: 'Telemetry ingested' });
    } catch (e) {
      console.error('Ingest error:', e);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });


  router.get('/status', (_req, res) => {
    const graph = graphStore.getGraph();
    const nodes = graph.nodes;
    const healthy = nodes.filter(n => n.status === 'healthy').length;
    const degraded = nodes.filter(n => n.status === 'degraded').length;
    const critical = nodes.filter(n => n.status === 'critical').length;
    const unknown = nodes.filter(n => n.status === 'unknown').length;

    let overallStatus: string = 'unknown';
    if (critical > 0) overallStatus = 'critical';
    else if (degraded > 0) overallStatus = 'degraded';
    else if (healthy > 0) overallStatus = 'healthy';

    res.json({
      status: overallStatus,
      healthy,
      degraded,
      critical,
      unknown,
      targets: graph.targets,
      lastUpdate: new Date().toISOString(),
    });
  });



  // --- TRAFFIC GENERATOR API ENDPOINTS ---
  router.get('/traffic/health', async (_req, res) => {
    if (!trafficController) return res.json({ reachable: false, url: null, projects: [] });
    res.json(await trafficController.getHealth());
  });

  // Operator-pinned entry point per target. Discovery can only report what a
  // container publishes, which isn't always what's reachable from here — so
  // this records the URL traffic should actually use, and the probe proves
  // it responds before anyone starts a run against it.
  router.get('/traffic/entrypoints', (_req, res) => {
    const cfgPath = path.join(process.cwd(), 'data', 'remote_config.json');
    const cfg = readJsonSafe(cfgPath) || {};
    const result: Record<string, { pinned: string | null; resolved: string | null; staleHost?: string }> = {};
    for (const targetId of Object.keys(cfg)) {
      const pinned = cfg[targetId]?.trafficBaseUrl ?? null;
      const entry: { pinned: string | null; resolved: string | null; staleHost?: string } = {
        pinned,
        resolved: trafficController?.resolveBaseUrl(targetId) ?? null,
      };
      // These instances get a new public IP on every stop/start, so a pin
      // made yesterday can quietly point at an address that now belongs to
      // nobody. Flag the mismatch instead of letting traffic fail silently.
      const currentIp = cfg[targetId]?.ec2PublicIp;
      if (pinned && currentIp && !/localhost|127\.0\.0\.1/.test(pinned) && !pinned.includes(currentIp)) {
        entry.staleHost = currentIp;
      }
      result[targetId] = entry;
    }
    res.json(result);
  });

  router.post('/traffic/entrypoint', (req, res) => {
    const { targetId, url } = req.body || {};
    if (!targetId) return res.status(400).json({ error: 'targetId is required' });
    const trimmed = typeof url === 'string' ? url.trim() : '';
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      return res.status(400).json({ error: 'url must start with http:// or https://' });
    }
    const cfgPath = path.join(process.cwd(), 'data', 'remote_config.json');
    const cfg = readJsonSafe(cfgPath) || {};
    if (!cfg[targetId]) return res.status(404).json({ error: `unknown target ${targetId}` });
    // Empty string clears the pin and falls back to discovery.
    if (trimmed) cfg[targetId].trafficBaseUrl = trimmed;
    else delete cfg[targetId].trafficBaseUrl;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    res.json({ success: true, targetId, pinned: trimmed || null, resolved: trafficController?.resolveBaseUrl(targetId) ?? null });
  });

  router.post('/traffic/entrypoint/probe', async (req, res) => {
    const { url, path: probePath = '/' } = req.body || {};
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'url must start with http:// or https://' });
    }
    const target = `${url.replace(/\/$/, '')}${probePath}`;
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const probe = await fetch(target, { signal: controller.signal });
      clearTimeout(timer);
      res.json({ reachable: true, status: probe.status, ms: Date.now() - started, url: target });
    } catch (e: any) {
      res.json({ reachable: false, error: e.name === 'AbortError' ? 'timed out after 10s' : e.message, ms: Date.now() - started, url: target });
    }
  });

  /**
   * Probe every discovered HTTP endpoint for a target and report which ones
   * actually answer. This is the "find all the entry points and see them
   * working" step: discovery says what is published, this says what responds.
   *
   * Read-only — it sends one GET per endpoint and starts no traffic. The
   * result feeds the sweep run, so an operator can see the surface before
   * committing load to it.
   */
  router.post('/traffic/surface/probe', async (req, res) => {
    if (!trafficController) return res.status(500).json({ error: 'Traffic controller unavailable' });
    const { targetId, includeInternal = false, timeoutMs, concurrency } = req.body || {};
    if (!targetId || typeof targetId !== 'string') {
      return res.status(400).json({ error: 'targetId is required' });
    }
    const report = await trafficController.probeSurface(targetId, {
      includeInternal: includeInternal === true,
      timeoutMs: Number(timeoutMs) || undefined,
      concurrency: Number(concurrency) || undefined,
    });
    res.json(report);
  });

  router.get('/traffic/status', (req, res) => {
    const targetId = req.query.targetId as string;
    if (experimentManager) {
      const statuses = trafficController?.getStatus(targetId) || [];
      const result = statuses.map(s => {
        const exp = experimentManager.getActiveExperiment(s.targetId);
        return {
          ...s,
          experimentId: exp?.experimentId,
          trafficStatistics: exp?.trafficStatistics,
          peakObservedMetrics: exp?.peakObservedMetrics
        };
      });
      res.json(result);
    } else if (trafficController) {
      res.json(trafficController.getStatus(targetId));
    } else {
      res.json([]);
    }
  });

  router.post('/traffic/start', async (req, res) => {
    if (!trafficController) return res.status(500).json({ error: 'Traffic controller unavailable' });
    const { targetId = 'all', profile = 'normal', mode = 'USER_JOURNEY', routeId, serviceId, endpointId, baseUrl, users, maxConcurrency, durationSec, endpointPaths } = req.body;

    const opts = {
      profile, mode, routeId, serviceId, endpointId, overrideUrl: baseUrl,
      ...coerceLoad({ users, maxConcurrency, durationSec, endpointPaths }),
    };
    if (targetId === 'all') {
      const stats = await Promise.all([
        trafficController.startTarget('sock-shop', opts),
        trafficController.startTarget('vertikal', opts),
      ]);
      return res.json(stats);
    } else {
      const stats = await trafficController.startTarget(targetId, opts);
      return res.json([stats]);
    }
  });


  router.post('/traffic/stop', async (req, res) => {
    if (!trafficController) return res.status(500).json({ error: 'Traffic controller unavailable' });
    const { targetId = 'all' } = req.body;

    if (targetId === 'all') {
      const stats = await trafficController.stopAll();
      if (experimentManager) {
        for (const s of stats) {
          experimentManager.stopExperiment(s.targetId, 'STOPPED');
        }
      }
      return res.json(stats);
    } else {
      if (experimentManager) {
        experimentManager.stopExperiment(targetId, 'STOPPED');
      }
      const stats = trafficController.stopTarget(targetId);
      return res.json([stats]);
    }
  });

  // --- EXPERIMENT API ENDPOINTS ---
  router.get('/experiments', (req, res) => {
    if (!experimentManager) return res.json([]);
    const targetId = req.query.targetId as string;
    res.json(experimentManager.experimentStore.getAllRecords(targetId));
  });

  router.post('/experiments/start', async (req, res) => {
    if (!experimentManager || !trafficController) return res.status(500).json({ error: 'Experiment manager unavailable' });
    const { targetId, profile = 'normal', mode = 'USER_JOURNEY', routeId, serviceId, endpointId, baseUrl, workloadSource = 'EXTERNAL', limits, config, users, maxConcurrency, durationSec, endpointPaths } = req.body;
    const load = coerceLoad({ users, maxConcurrency, durationSec, endpointPaths });
    
    if (!targetId || targetId === 'all') {
      return res.status(400).json({ error: 'Must specify a single targetId for an experiment' });
    }

    const expId = experimentManager.startExperiment(
      targetId, 
      workloadSource, 
      profile, 
      config || { mode, rate: 0, concurrency: load.users ?? 1, durationSeconds: load.durationSec ?? 0 },
      limits
    );

    const opts = { profile, mode, routeId, serviceId, endpointId, overrideUrl: baseUrl, workloadSource, ...load };
    const stats = await trafficController.startTarget(targetId, opts);

    // If the workload never started there is no experiment to observe, so
    // close the record out rather than leaving it RUNNING forever and
    // report the failure to the caller.
    if (!stats.isRunning) {
      experimentManager?.stopExperiment(targetId, 'STOPPED');
      return res.status(502).json({ error: stats.error || 'Traffic failed to start', experimentId: expId, trafficStatus: stats });
    }

    return res.json({ experimentId: expId, trafficStatus: stats });
  });

  router.post('/experiments/update_stats', (req, res) => {
    if (!experimentManager) return res.status(500).json({ error: 'Experiment manager unavailable' });
    const { targetId, stats } = req.body;
    
    if (targetId && stats) {
      experimentManager.updateExperimentStats(targetId, stats);
    }
    res.json({ success: true });
  });

  // --- ML PIPELINE STATUS (ml/collector.py, preprocess.py, train.py, score.py) ---
  const mlDataDir = path.resolve(process.cwd(), '..', 'core', 'ml', 'data');
  const mlModelsDir = path.resolve(process.cwd(), '..', 'core', 'ml', 'models');

  const readJsonSafe = (filePath: string): any => {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  };

  router.get('/ml/status', (_req, res) => {
    res.json({
      collection: readJsonSafe(path.join(mlDataDir, 'collection_summary.json')),
      preprocessing: readJsonSafe(path.join(mlDataDir, 'preprocess_summary.json')),
      training: readJsonSafe(path.join(mlModelsDir, 'training_summary.json')),
      scoring: readJsonSafe(path.join(mlDataDir, 'scoring_summary.json')),
      liveScores: readJsonSafe(path.join(mlDataDir, 'latest_scores.json')),
    });
  });

  const mlConfigPath = path.resolve(process.cwd(), '..', 'core', 'ml', 'config.json');
  const mlDir = path.resolve(process.cwd(), '..', 'core', 'ml');

  router.get('/ml/config', (_req, res) => {
    res.json(readJsonSafe(mlConfigPath) || {});
  });

  const ALL_FEATURE_COLUMNS = ['z_cpu_percent', 'z_memory_percent', 'z_network_rx_rate', 'z_network_tx_rate'];

  router.post('/ml/config', (req, res) => {
    const allowedKeys = [
      'collect_interval_sec', 'min_samples_per_service', 'min_training_samples', 'contamination',
      'score_interval_sec', 'persistence_windows', 'n_estimators', 'max_samples_fraction',
    ];
    const current = readJsonSafe(mlConfigPath) || {};
    const updates: Record<string, any> = {};
    for (const key of allowedKeys) {
      if (req.body[key] === undefined) continue;
      const val = Number(req.body[key]);
      if (!Number.isFinite(val) || val <= 0) {
        return res.status(400).json({ error: `${key} must be a positive number` });
      }
      updates[key] = val;
    }
    if (updates.contamination !== undefined && updates.contamination >= 0.5) {
      return res.status(400).json({ error: 'contamination must be < 0.5 (IsolationForest requirement)' });
    }
    if (updates.max_samples_fraction !== undefined && updates.max_samples_fraction > 1) {
      return res.status(400).json({ error: 'max_samples_fraction must be between 0 and 1' });
    }
    // holdout_fraction is allowed to be 0 (train on everything), so it can't
    // go through the positive-number loop above.
    if (req.body.holdout_fraction !== undefined) {
      const val = Number(req.body.holdout_fraction);
      if (!Number.isFinite(val) || val < 0 || val >= 0.5) {
        return res.status(400).json({ error: 'holdout_fraction must be between 0 and 0.5' });
      }
      updates.holdout_fraction = val;
    }
    if (req.body.feature_columns !== undefined) {
      const cols = req.body.feature_columns;
      if (!Array.isArray(cols) || cols.length === 0 || cols.some((c: any) => !ALL_FEATURE_COLUMNS.includes(c))) {
        return res.status(400).json({ error: `feature_columns must be a non-empty subset of ${ALL_FEATURE_COLUMNS.join(', ')}` });
      }
      updates.feature_columns = cols;
    }
    const next = { ...current, ...updates };
    fs.writeFileSync(mlConfigPath, JSON.stringify(next, null, 2));
    res.json({ success: true, config: next });
  });

  // --- ML LONG-RUNNING PROCESS CONTROL (collector.py, score.py) ---
  // These two run continuously. Previously they could only be started from a
  // shell, so the UI had no way to tell whether the numbers on screen were
  // live or frozen. The server supervises them here, and also detects
  // instances started outside it so the reported state is the truth rather
  // than just "what this server launched".
  const mlLogsDir = path.resolve(process.cwd(), '..', 'core', 'ml', 'logs');
  type MlProcName = 'collector' | 'scorer';
  const ML_PROC_SCRIPTS: Record<MlProcName, string> = { collector: 'collector.py', scorer: 'score.py' };
  const managedMlProcs = new Map<MlProcName, { child: ReturnType<typeof spawn>; startedAt: string }>();

  const findExternalPid = (script: string): number | null => {
    try {
      // Anchored: an unanchored match also hits shell wrappers whose command
      // line merely contains "python3 <script>", and killing the wrapper
      // would leave the actual interpreter running.
      // pgrep does not exist on Windows; there we only know about processes we started.
      if (IS_WINDOWS) return null;
      const pattern = `^python[0-9.]* ${script.replace('.', '\\.')}$`;
      const out = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim();
      const pid = out.split('\n').map((l) => parseInt(l, 10)).find((n) => Number.isFinite(n));
      return pid ?? null;
    } catch {
      return null; // pgrep exits non-zero when nothing matches
    }
  };

  const tailFile = (filePath: string, lines: number): string[] => {
    try {
      return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).slice(-lines);
    } catch {
      return [];
    }
  };

  const mlProcStatus = (name: MlProcName) => {
    const managed = managedMlProcs.get(name);
    const alive = managed && managed.child.exitCode === null && !managed.child.killed;
    const externalPid = alive ? null : findExternalPid(ML_PROC_SCRIPTS[name]);
    return {
      name,
      script: ML_PROC_SCRIPTS[name],
      running: Boolean(alive || externalPid),
      managed: Boolean(alive),
      pid: alive ? managed!.child.pid : externalPid,
      startedAt: alive ? managed!.startedAt : null,
      log: tailFile(path.join(mlLogsDir, `${name}.log`), 60),
    };
  };

  router.get('/ml/processes', (_req, res) => {
    res.json({ collector: mlProcStatus('collector'), scorer: mlProcStatus('scorer') });
  });

  router.post('/ml/processes/:name/start', (req, res) => {
    const name = req.params.name as MlProcName;
    if (!ML_PROC_SCRIPTS[name]) return res.status(400).json({ error: 'Unknown process' });
    const status = mlProcStatus(name);
    if (status.running) return res.status(409).json({ error: `${name} is already running (pid ${status.pid})` });

    fs.mkdirSync(mlLogsDir, { recursive: true });
    const logPath = path.join(mlLogsDir, `${name}.log`);
    const logFd = fs.openSync(logPath, 'a');
    const child = spawn(pythonCmd(), [ML_PROC_SCRIPTS[name]], {
      cwd: mlDir,
      stdio: ['ignore', logFd, logFd],
    });
    const releaseFd = () => {
      try { fs.closeSync(logFd); } catch { /* already closed */ }
    };
    child.on('close', () => {
      releaseFd();
      managedMlProcs.delete(name);
    });
    // spawn emits 'error' when the binary is missing (no python3 on PATH).
    // Unhandled, that event throws; worse, the process stayed registered as
    // running when it never started, and the log fd was never released.
    child.on('error', (err) => {
      console.error(`[ML] Failed to start ${name}:`, err.message);
      releaseFd();
      managedMlProcs.delete(name);
    });
    managedMlProcs.set(name, { child, startedAt: new Date().toISOString() });
    res.json({ success: true, pid: child.pid });
  });

  router.post('/ml/processes/:name/stop', (req, res) => {
    const name = req.params.name as MlProcName;
    if (!ML_PROC_SCRIPTS[name]) return res.status(400).json({ error: 'Unknown process' });
    const status = mlProcStatus(name);
    if (!status.running || !status.pid) return res.status(409).json({ error: `${name} is not running` });
    try {
      process.kill(status.pid, 'SIGTERM');
    } catch (e: any) {
      return res.status(500).json({ error: `Failed to stop ${name}: ${e.message}` });
    }
    managedMlProcs.delete(name);
    res.json({ success: true });
  });

  // Per-model metadata (feature set, training size, threshold, holdout
  // evaluation) straight from each models/*.meta.json written by train.py.
  router.get('/ml/models', (_req, res) => {
    try {
      const files = fs.readdirSync(mlModelsDir).filter((f) => f.endsWith('.meta.json'));
      const models = files.map((f) => readJsonSafe(path.join(mlModelsDir, f))).filter(Boolean);
      res.json(models);
    } catch {
      res.json([]);
    }
  });

  // Recent rows of the exact feature table train.py fits on, so the UI can
  // show what the model actually sees rather than a re-derived approximation.
  router.get('/ml/features', (req, res) => {
    const featuresPath = path.join(mlDataDir, 'features.csv');
    if (!fs.existsSync(featuresPath)) return res.json({ columns: [], rows: [] });
    const serviceId = req.query.serviceId as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 300, 2000);
    // Reads backwards from EOF and stops once it has `limit` rows, instead
    // of loading all 33 MB to return 300 of them. See util/tailCsv.ts — the
    // old path spent 141ms, of which 0.3ms was the actual answer.
    const columns = readCsvHeader(featuresPath);
    const sidIndex = columns.indexOf('service_id');
    const matchesService = serviceId
      ? (line: string) => fieldAt(line, sidIndex) === serviceId
      : undefined;
    const rows = tailCsvLines(featuresPath, { limit, match: matchesService })
      .map((line) => {
        const parts = line.split(',');
        const row: Record<string, any> = {};
        columns.forEach((col, i) => {
          const raw = parts[i];
          const num = Number(raw);
          row[col] = raw === '' || raw === undefined ? null : (Number.isFinite(num) && raw.trim() !== '' ? num : raw);
        });
        return row;
      });
    res.json({ columns, rows });
  });

  router.get('/ml/normalization', (_req, res) => {
    res.json(readJsonSafe(path.join(mlDataDir, 'normalization_stats.json')) || {});
  });

  // preprocess.py + train.py are one-shot scripts; run them sequentially on
  // demand so a config/data change can be reflected without a manual SSH
  // session. collector.py/score.py are long-running and hot-reload
  // config.json on their own, so they're not touched here.
  let retrainState: { running: boolean; startedAt: string | null; finishedAt: string | null; log: string[]; exitCode: number | null } = {
    running: false, startedAt: null, finishedAt: null, log: [], exitCode: null,
  };

  router.get('/ml/retrain', (_req, res) => {
    res.json(retrainState);
  });

  router.post('/ml/retrain', (req, res) => {
    if (retrainState.running) {
      return res.status(409).json({ error: 'A retrain is already running' });
    }
    const { since, until, project, algorithms, contamination, nEstimators, minSamples, holdoutFraction, skipPreprocess } = req.body || {};
    retrainState = { running: true, startedAt: new Date().toISOString(), finishedAt: null, log: [], exitCode: null };

    // Bounded: train.py emits a line per trained AND per skipped service, so
    // on a 76-service deployment this array grew for the whole run and every
    // byte of it was re-sent on each 2-second poll of GET /api/ml/retrain.
    // The UI only ever renders the tail.
    const MAX_LOG_LINES = 500;
    const appendLog = (chunk: Buffer | string) => {
      const text = chunk.toString('utf8').trim();
      if (!text) return;
      retrainState.log.push(text);
      if (retrainState.log.length > MAX_LOG_LINES) {
        retrainState.log = retrainState.log.slice(-MAX_LOG_LINES);
      }
    };

    const runStep = (cmd: string, args: string[]) => new Promise<number>((resolve) => {
      const child = spawn(cmd, args, { cwd: mlDir });
      child.stdout?.on('data', appendLog);
      child.stderr?.on('data', appendLog);
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', (err) => {
        // spawn itself can fail (python3 missing from PATH). Without this the
        // promise never settles and the retrain is stuck "running" forever.
        appendLog(`Failed to start ${cmd}: ${err.message}`);
        resolve(1);
      });
    });

    // Only forward a flag the caller actually set, so train.py's own
    // defaults (which come from ml/config.json) stay in charge otherwise.
    const numericArg = (name: string, value: unknown, args: string[]) => {
      const n = Number(value);
      if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return;
      args.push(name, String(n));
    };

    (async () => {
      // Preprocessing rebuilds features.csv for every service at once; it is
      // not project-scoped and is the slow step, so a caller tuning
      // hyperparameters against unchanged data can skip it.
      if (!skipPreprocess) {
        const preCode = await runStep(pythonCmd(), ['preprocess.py']);
        if (preCode !== 0) {
          retrainState = { ...retrainState, running: false, finishedAt: new Date().toISOString(), exitCode: preCode };
          return;
        }
      } else {
        appendLog('[retrain] skipping preprocess — reusing the existing features.csv');
      }

      const trainArgs = ['train.py'];
      if (since) trainArgs.push('--since', since);
      if (until) trainArgs.push('--until', until);
      if (typeof project === 'string' && project.trim() && project !== 'ALL') {
        trainArgs.push('--project', project.trim());
      }
      if (typeof algorithms === 'string' && algorithms.trim()) {
        trainArgs.push('--algorithms', algorithms.trim());
      } else if (Array.isArray(algorithms) && algorithms.length > 0) {
        trainArgs.push('--algorithms', algorithms.join(','));
      }
      numericArg('--contamination', contamination, trainArgs);
      numericArg('--n-estimators', nEstimators, trainArgs);
      numericArg('--min-samples', minSamples, trainArgs);
      numericArg('--holdout-fraction', holdoutFraction, trainArgs);

      appendLog(`[retrain] ${pythonCmd()} ${trainArgs.join(' ')}`);
      const trainCode = await runStep(pythonCmd(), trainArgs);
      retrainState = { ...retrainState, running: false, finishedAt: new Date().toISOString(), exitCode: trainCode };
    })();

    res.json({ success: true, message: 'Retrain started' });
  });

  /**
   * The actual source of the pipeline scripts, so the execution panel shows
   * what really runs rather than a prose description of it that can drift.
   * Read-only and allow-listed by name — this serves files, and the set of
   * files it will serve is fixed here rather than taken from the request.
   */
  router.get('/ml/source/:name', (req, res) => {
    const ALLOWED: Record<string, string> = {
      collector: 'collector.py',
      preprocess: 'preprocess.py',
      train: 'train.py',
      score: 'score.py',
      config: 'mlconfig.py',
    };
    const file = ALLOWED[req.params.name];
    if (!file) {
      return res.status(404).json({ error: `unknown source '${req.params.name}'`, available: Object.keys(ALLOWED) });
    }
    const full = path.join(mlDir, file);
    if (!fs.existsSync(full)) return res.status(404).json({ error: `${file} not found` });
    try {
      const code = fs.readFileSync(full, 'utf8');
      res.json({ name: req.params.name, file, code, lines: code.split('\n').length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Hyperparameter suggestions computed from the data that is actually there.
   *
   * Deliberately not a table of textbook defaults. The useful question is not
   * "what is a normal contamination" but "what will happen to *these* services
   * at that value", and that depends on facts only the feature table knows —
   * above all how many DISTINCT rows each service has, which on these targets
   * is a tiny fraction of the row count because collection polls faster than
   * the metrics change.
   *
   * Every suggestion carries its reason, and anything the data cannot answer
   * says so rather than inventing a number. Contamination in particular is a
   * prior about how much of the data is anomalous; unlabelled data cannot
   * tell you that, so what is offered is the consequence of choosing it.
   */
  let suggestCache: { at: number; key: string; body: any } | null = null;

  router.get('/ml/suggestions', (req, res) => {
    const project = typeof req.query.project === 'string' && req.query.project !== 'ALL'
      ? req.query.project
      : undefined;
    const cacheKey = project ?? 'ALL';

    // Parsing a 147k-line CSV per keystroke would be silly; the numbers move
    // only when preprocessing reruns.
    if (suggestCache && suggestCache.key === cacheKey && Date.now() - suggestCache.at < 30_000) {
      return res.json(suggestCache.body);
    }

    const featuresPath = path.join(mlDataDir, 'features.csv');
    if (!fs.existsSync(featuresPath)) {
      return res.json({ available: false, reason: 'No features.csv yet — run preprocessing first.' });
    }

    const Z_COLUMNS = ['z_cpu_percent', 'z_memory_percent', 'z_network_rx_rate', 'z_network_tx_rate'];
    const perService = new Map<string, { rows: number; distinct: Set<string> }>();

    try {
      const text = fs.readFileSync(featuresPath, 'utf8');
      const lines = text.split('\n');
      const header = lines[0].split(',');
      const sidIdx = header.indexOf('service_id');
      const zIdx = Z_COLUMNS.map((c) => header.indexOf(c));
      if (sidIdx < 0 || zIdx.some((i) => i < 0)) {
        return res.json({ available: false, reason: 'features.csv is missing the expected columns.' });
      }

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const cells = line.split(',');
        const sid = cells[sidIdx];
        if (!sid) continue;
        if (project && !sid.startsWith(`${project}:`)) continue;
        // A row with any missing feature is dropped by train.py too.
        const key = zIdx.map((i2) => cells[i2]).join(',');
        if (key.split(',').some((v) => v === '' || v === undefined)) continue;
        let entry = perService.get(sid);
        if (!entry) { entry = { rows: 0, distinct: new Set() }; perService.set(sid, entry); }
        entry.rows++;
        entry.distinct.add(key);
      }
    } catch (e: any) {
      return res.json({ available: false, reason: `Could not read features.csv: ${e.message}` });
    }

    const services = Array.from(perService.entries())
      .map(([sid, v]) => ({ sid, rows: v.rows, distinct: v.distinct.size }))
      .sort((a, b) => a.distinct - b.distinct);

    if (services.length === 0) {
      return res.json({ available: false, reason: project ? `No feature rows for ${project}.` : 'No feature rows yet.' });
    }

    const median = (xs: number[]) => {
      const a = [...xs].sort((x, y) => x - y);
      const mid = Math.floor(a.length / 2);
      return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
    };

    const rowCounts = services.map((s) => s.rows);
    const distinctCounts = services.map((s) => s.distinct);
    const medRows = median(rowCounts);
    const medDistinct = median(distinctCounts);
    const minRows = Math.min(...rowCounts);
    const thin = services.filter((s) => s.distinct / Math.max(s.rows, 1) < 0.05);
    const lofCapable = services.filter((s) => s.distinct >= 20);

    // min_samples: keep as many services as possible while still leaving a
    // holdout. Anything below the smallest service's row count trains
    // everything; the default of 30 is only a problem when services are
    // genuinely short of data.
    const wouldSkip = (threshold: number) => services.filter((s) => s.rows < threshold).length;

    // n_estimators buys score stability, and stability is bounded by how many
    // distinct points there are to partition. More trees over 6 distinct rows
    // is just a more precise answer to a question the data cannot support.
    const nEstimators = medDistinct < 50 ? 100 : medDistinct < 500 ? 200 : 300;

    // holdout_fraction must leave a tail big enough to mean something while
    // keeping enough rows to fit.
    const holdout = medRows >= 500 ? 0.2 : medRows >= 150 ? 0.15 : 0.1;

    const body = {
      available: true,
      project: project ?? 'ALL',
      observed: {
        services: services.length,
        median_rows: medRows,
        median_distinct: medDistinct,
        min_rows: minRows,
        thin_services: thin.length,
        lof_capable_services: lofCapable.length,
        thinnest: services.slice(0, 3).map((s) => ({ sid: s.sid, rows: s.rows, distinct: s.distinct })),
      },
      suggestions: {
        contamination: {
          suggested: 0.01,
          range: [0.005, 0.05],
          hard_limits: [0.0001, 0.5],
          reason:
            'A prior, not something unlabelled data can tell you: it sets where the alert threshold ' +
            'lands, not how many anomalies exist. Raise it to make every detector fire more readily. ' +
            `Across ${services.length} service(s) here the training data is ` +
            `${medDistinct}/${medRows} distinct rows at the median, so the threshold is being drawn ` +
            'from a small number of genuinely different points whatever value you pick.',
        },
        n_estimators: {
          suggested: nEstimators,
          range: [100, 300],
          hard_limits: [10, 1000],
          reason:
            `${nEstimators} — more trees buy score stability, and stability is capped by how many ` +
            `distinct points there are to partition (median ${medDistinct} here). Past ~200 the ` +
            'returns are small and the cost is linear. Isolation Forest only; the other three ignore it.',
        },
        min_samples: {
          suggested: Math.max(30, Math.min(50, Math.floor(medRows / 10))),
          range: [30, Math.max(30, Math.floor(medRows / 5))],
          hard_limits: [10, 100000],
          reason:
            `At 30 it skips ${wouldSkip(30)} of ${services.length} service(s); at 100 it would skip ` +
            `${wouldSkip(100)}. Counts raw rows, not distinct ones, so a service can clear this ` +
            'comfortably and still carry almost no signal — check "thin data" before trusting a pass.',
        },
        holdout_fraction: {
          suggested: holdout,
          range: [0.1, 0.3],
          hard_limits: [0, 0.9],
          reason:
            `${holdout} leaves about ${Math.round(medRows * holdout)} rows held out at the median ` +
            `service (${medRows} rows). The split is chronological, so the holdout is the most recent ` +
            'data — a high firing rate on it usually means the system changed, not that the model is wrong.',
        },
        algorithms: {
          suggested: lofCapable.length >= services.length / 2
            ? ['iforest', 'lof', 'ocsvm', 'zscore']
            : ['iforest', 'ocsvm', 'zscore'],
          reason:
            `${lofCapable.length} of ${services.length} service(s) have the 20+ distinct rows LOF ` +
            'needs for a density model; it refuses on the rest and records why. ' +
            'Keep zscore whatever else you run — it needs no fitting and is the interpretable ' +
            'baseline the others have to beat.',
        },
      },
      warnings: [
        ...(thin.length > 0
          ? [`${thin.length} of ${services.length} service(s) are under 5% distinct rows. No hyperparameter fixes that — it needs slower collection or longer, more varied runs.`]
          : []),
        ...(minRows < 30
          ? [`The smallest service has ${minRows} feature row(s), below the default min_samples of 30, so it will be skipped.`]
          : []),
      ],
    };

    suggestCache = { at: Date.now(), key: cacheKey, body };
    res.json(body);
  });

  /** Which projects have data, so the UI can scope to one at a time. */
  router.get('/ml/projects', (_req, res) => {
    const featuresPath = path.join(mlDataDir, 'features.csv');
    const projects = new Set<string>();
    try {
      if (fs.existsSync(featuresPath)) {
        const lines = fs.readFileSync(featuresPath, 'utf8').split('\n').filter(Boolean);
        const columns = lines[0].split(',');
        const sidIndex = columns.indexOf('service_id');
        if (sidIndex >= 0) {
          for (const line of lines.slice(1)) {
            const sid = line.split(',')[sidIndex];
            if (sid && sid.includes(':')) projects.add(sid.split(':')[0]);
          }
        }
      }
    } catch { /* fall through to whatever models tell us */ }
    try {
      for (const f of fs.readdirSync(mlModelsDir)) {
        if (!f.endsWith('.meta.json')) continue;
        const meta = readJsonSafe(path.join(mlModelsDir, f));
        const sid = meta?.service_id;
        if (typeof sid === 'string' && sid.includes(':')) projects.add(sid.split(':')[0]);
      }
    } catch { /* none yet */ }
    res.json(Array.from(projects).sort());
  });

  router.get('/ml/score-history', (req, res) => {
    const historyPath = path.join(mlDataDir, 'score_history.csv');
    if (!fs.existsSync(historyPath)) return res.json([]);
    const serviceId = req.query.serviceId as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 200, 2000);
    const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
    const rows = lines.slice(1) // skip header
      .map((line) => {
        const [timestamp, service_id, anomaly_score, above_threshold, persistent] = line.split(',');
        return { timestamp, service_id, anomaly_score: Number(anomaly_score), above_threshold: above_threshold === 'True', persistent: persistent === 'True' };
      })
      .filter((r) => !serviceId || r.service_id === serviceId);
    res.json(rows.slice(-limit));
  });

  // --- CONFIGURATION API ENDPOINTS ---
  const configPath = path.join(process.cwd(), 'data', 'remote_config.json');

  router.get('/config/remote', (_req, res) => {
    try {
      if (fs.existsSync(configPath)) {
        const data = fs.readFileSync(configPath, 'utf8');
        res.json(JSON.parse(data));
      } else {
        res.json({});
      }
    } catch (e) {
      console.error('Error reading remote config:', e);
      res.status(500).json({ error: 'Failed to read config' });
    }
  });

  router.post('/config/remote', (req, res) => {
    try {
      const { targetId, projectName, ec2PublicIp, sshKeyPath, sshUsername, composeFilePath } = req.body;
      let currentConfig: any = {};
      
      if (fs.existsSync(configPath)) {
        try {
          currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) { /* ignore parse error */ }
      }
      
      const key = targetId || 'default';
      const newConfig = {
        ...currentConfig,
        [key]: {
          // Merge onto the existing entry rather than replacing it: this
          // record also holds settings the edit form doesn't send, such as
          // the pinned traffic entry point. Replacing wholesale silently
          // erased them every time someone updated an IP.
          ...(currentConfig[key] || {}),
          ec2PublicIp,
          sshKeyPath,
          sshUsername,
          composeFilePath,
          displayName: projectName || targetId,
          updatedAt: new Date().toISOString()
        }
      };

      if (!fs.existsSync(path.dirname(configPath))) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
      }

      fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf8');
      
      // Register in GraphStore immediately (triggering background SSH discovery)
      graphStore.registerNewProject(targetId, projectName || targetId, ec2PublicIp);
      
      // Sync into memory for runtime usage
      if (ec2PublicIp) {
        process.env.AWS_EC2_PUBLIC_IP = ec2PublicIp;
      }
      
      res.json({ success: true, config: newConfig });
    } catch (e) {
      console.error('Error saving remote config:', e);
      res.status(500).json({ error: 'Failed to save config' });
    }
  });

  return router;
}