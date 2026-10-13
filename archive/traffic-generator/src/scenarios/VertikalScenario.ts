import { StatsCollector } from '../core/StatsCollector.js';
import { TestUserManager } from '../core/TestUserManager.js';

export class VertikalScenario {
  private baseUrl: string;
  private studioUrl: string;
  private mailUrl: string;
  private stats: StatsCollector;
  private timeoutMs: number;

  constructor(baseUrl: string, stats: StatsCollector, timeoutMs: number = 5000) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    
    // Derive auxiliary service URLs assuming they run on the same host using standard ports
    try {
      const url = new URL(this.baseUrl);
      this.studioUrl = `${url.protocol}//${url.hostname}:54323`;
      this.mailUrl = `${url.protocol}//${url.hostname}:54324`;
    } catch {
      this.studioUrl = 'http://localhost:54323';
      this.mailUrl = 'http://localhost:54324';
    }

    this.stats = stats;
    this.timeoutMs = timeoutMs;
  }

  public async executeJourney(): Promise<void> {
    const randomScenario = Math.random();

    if (randomScenario < 0.2) {
      await this.gatewayHealthAndRestJourney();
    } else if (randomScenario < 0.5) {
      await this.authSignupFlow();
    } else if (randomScenario < 0.8) {
      await this.studioWorkflow();
    } else {
      await this.fullStorefrontWorkflow();
    }
  }

  private async gatewayHealthAndRestJourney(): Promise<void> {
    // 1. Gateway Health check
    await this.step('gateway_health', () => this.request('GET', '/health', this.baseUrl));

    // 2. PostgREST API query via NGINX gateway (/rest/v1/)
    await this.step('rest_api_root', () => this.request('GET', '/rest/v1/', this.baseUrl, undefined, { 'Accept-Profile': 'public' }));
  }

  private async authSignupFlow(): Promise<void> {
    // 1. Auth GoTrue Settings (/auth/v1/settings)
    await this.step('auth_settings', () => this.request('GET', '/auth/v1/settings', this.baseUrl));

    // 2. User Signup Attempt (Triggers email to Mailpit!)
    const user = TestUserManager.getNextTestUser();
    await this.step('auth_signup', () => this.request('POST', '/auth/v1/signup', this.baseUrl, {
      email: user.email,
      password: user.password
    }));

    // 3. User checks their email via Mailpit UI workflow
    await this.step('mailpit_check', () => this.request('GET', '/api/v1/messages', this.mailUrl));
  }

  private async studioWorkflow(): Promise<void> {
    // 1. User loads Supabase Studio Dashboard (Triggers SSR queries to Meta API!)
    await this.step('studio_dashboard', () => this.request('GET', '/', this.studioUrl));
    
    // 2. Studio pings health or project data
    await this.step('studio_api', () => this.request('GET', '/api/profile', this.studioUrl));
  }

  private async fullStorefrontWorkflow(): Promise<void> {
    await this.gatewayHealthAndRestJourney();
    
    const user = TestUserManager.getNextTestUser();
    await this.step('auth_token', () => this.request('POST', '/auth/v1/token?grant_type=password', this.baseUrl, {
      email: user.email,
      password: user.password
    }));

    // Query REST API for schema/tables
    await this.step('rest_schema_query', () => this.request('GET', '/rest/v1/', this.baseUrl, undefined, { 'Prefer': 'count=exact' }));
  }

  private async request(method: string, path: string, base: string, body?: any, headers: Record<string, string> = {}): Promise<{ status: number; data: any }> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const opts: RequestInit = {
        method,
        headers: {
          'User-Agent': 'MicroserviceMapper-TrafficGen/1.0',
          'Accept': 'application/json, text/html, */*',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        signal: controller.signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
      };
      const response = await fetch(`${base}${path}`, opts);
      clearTimeout(id);
      let data: any = null;
      try {
        const text = await response.text();
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        data = null;
      }
      return { status: response.status, data };
    } catch (err) {
      clearTimeout(id);
      throw err;
    }
  }

  private async step(actionName: string, fn: () => Promise<any>): Promise<void> {
    const start = Date.now();
    try {
      const res = await fn();
      const latency = Date.now() - start;
      const statusCode = res?.status || 200;
      const isErr = statusCode >= 400;
      this.stats.recordRequest(actionName, statusCode, latency, isErr);
    } catch (e: any) {
      const latency = Date.now() - start;
      const isTimeout = e.name === 'AbortError' || e.message?.includes('aborted');
      this.stats.recordRequest(actionName, null, latency, true, isTimeout);
    }
  }
}
