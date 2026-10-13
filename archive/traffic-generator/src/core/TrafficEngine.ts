import { getConfig, PROFILES, type TrafficProfile } from '../config/index.js';
import { StatsCollector } from './StatsCollector.js';
import { SockShopScenario } from '../scenarios/SockShopScenario.js';
import { VertikalScenario } from '../scenarios/VertikalScenario.js';

export class TrafficEngine {
  public targetId: string;
  private isRunning: boolean = false;
  private profile: TrafficProfile;
  public stats: StatsCollector;
  private timer: NodeJS.Timeout | null = null;
  private rampStartTime: number = 0;
  private baseUrl: string;
  private mode: string;
  private targetedRoute?: string;
  private serviceFilter?: string;
  private endpointId?: string;
  private sockShopScenario: SockShopScenario | null = null;
  private vertikalScenario: VertikalScenario | null = null;

  constructor(
    targetId: string,
    customBaseUrl?: string,
    profileName: string = 'normal',
    mode: string = 'USER_JOURNEY',
    targetedRoute?: string,
    serviceFilter?: string,
    endpointId?: string
  ) {
    this.targetId = targetId;
    this.profile = PROFILES[profileName] || PROFILES.normal;
    this.stats = new StatsCollector(targetId);
    this.mode = mode;
    this.targetedRoute = targetedRoute;
    this.serviceFilter = serviceFilter;
    this.endpointId = endpointId;

    const config = getConfig();
    if (targetId.includes('sock') || targetId.includes('sock-shop')) {
      this.baseUrl = customBaseUrl || config.sockShopBaseUrl;
      this.sockShopScenario = new SockShopScenario(this.baseUrl, this.stats, config.timeoutMs);
    } else {
      this.baseUrl = customBaseUrl || config.vertikalBaseUrl;
      this.vertikalScenario = new VertikalScenario(this.baseUrl, this.stats, config.timeoutMs);
    }
  }

  public start(profileName?: string) {
    if (this.isRunning) return;
    if (profileName && PROFILES[profileName]) {
      this.profile = PROFILES[profileName];
    }

    if (this.profile.name === 'stress' && !this.profile.allowStress) {
      console.warn('[TrafficEngine] Stress profile requested but disabled. Falling back to moderate.');
      this.profile = PROFILES.moderate;
    }

    this.isRunning = true;
    this.rampStartTime = Date.now();
    this.stats.start(this.profile.name);
    console.log(`[TrafficEngine] Started traffic for ${this.targetId} -> ${this.baseUrl} (Mode: ${this.mode}, Profile: ${this.profile.name}, Concurrency: ${this.profile.concurrency})`);

    // Worker loop
    this.runLoop();
  }

  public stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stats.stop();
    console.log(`[TrafficEngine] Stopped traffic for ${this.targetId}`);
  }

  private async runLoop() {
    if (!this.isRunning) return;

    if (this.profile.name === 'ramp') {
      // Increase rate dynamically for ramp: e.g. +2 req/s every 5 seconds
      const elapsedSec = (Date.now() - this.rampStartTime) / 1000;
      const initialRate = 2;
      const maxRate = 50;
      const increment = 2; // +2 per interval
      const intervalSec = 5;
      
      const newRate = initialRate + Math.floor(elapsedSec / intervalSec) * increment;
      this.profile.rateLimitPerSec = Math.min(maxRate, newRate);
      this.profile.concurrency = Math.max(1, Math.min(20, Math.ceil(this.profile.rateLimitPerSec / 2)));
    }

    const workers: Promise<void>[] = [];
    for (let i = 0; i < this.profile.concurrency; i++) {
      workers.push(this.executeWorkerStep());
    }

    await Promise.all(workers);

    if (this.isRunning) {
      const targetDelay = 1000 / (this.profile.rateLimitPerSec / this.profile.concurrency);
      this.timer = setTimeout(() => this.runLoop(), Math.max(20, targetDelay));
    }
  }

  private async executeWorkerStep(): Promise<void> {
    if (!this.isRunning) return;
    try {
      if (this.mode === 'ENDPOINT' && this.targetedRoute) {
        await this.executeTargetedRoute(this.targetedRoute);
      } else if (this.mode === 'SERVICE' && this.serviceFilter) {
        await this.executeServiceTraffic(this.serviceFilter);
      } else {
        if (this.sockShopScenario) {
          await this.sockShopScenario.executeJourney();
        } else if (this.vertikalScenario) {
          await this.vertikalScenario.executeJourney();
        }
      }
    } catch (e: any) {
      // Handled inside scenarios
    }
  }

  private async executeTargetedRoute(route: string): Promise<void> {
    const startTime = Date.now();
    try {
      const cleanPath = route.startsWith('/') ? route : `/${route}`;
      const url = `${this.baseUrl.replace(/\/$/, '')}${cleanPath}`;
      const res = await fetch(url);
      const latency = Date.now() - startTime;
      this.stats.recordRequest(res.ok ? 'success' : 'error', res.status, latency);
    } catch (e: any) {
      const latency = Date.now() - startTime;
      this.stats.recordRequest('error', 500, latency, true);
    }
  }

  private async executeServiceTraffic(serviceName: string): Promise<void> {
    // Route traffic through public entry point that reaches target service
    const serviceRoutes: Record<string, string> = {
      'catalogue': '/catalogue',
      'carts': '/cart',
      'orders': '/orders',
      'user': '/login',
      'front-end': '/',
      'vertikal-auth': '/auth/v1/health',
      'vertikal-rest': '/rest/v1/schema',
      'vertikal-meta': '/rest/v1/meta',
      'storefront': '/',
      'vertikal-gateway': '/health'
    };

    const targetRoute = serviceRoutes[serviceName] || '/';
    await this.executeTargetedRoute(targetRoute);
  }

  public getDiagnostics() {
    return this.stats.getDiagnostics();
  }
}
