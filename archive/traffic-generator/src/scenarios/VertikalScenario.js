import { TestUserManager } from '../core/TestUserManager.js';
export class VertikalScenario {
    baseUrl;
    stats;
    timeoutMs;
    constructor(baseUrl, stats, timeoutMs = 5000) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.stats = stats;
        this.timeoutMs = timeoutMs;
    }
    async executeJourney() {
        const randomScenario = Math.random();
        if (randomScenario < 0.4) {
            await this.gatewayHealthAndRestJourney();
        }
        else if (randomScenario < 0.75) {
            await this.authFlowJourney();
        }
        else {
            await this.fullStorefrontWorkflow();
        }
    }
    async gatewayHealthAndRestJourney() {
        // 1. Gateway Health check
        await this.step('gateway_health', () => this.request('GET', '/health'));
        // 2. PostgREST API query via NGINX gateway (/rest/v1/)
        await this.step('rest_api_root', () => this.request('GET', '/rest/v1/', undefined, { 'Accept-Profile': 'public' }));
    }
    async authFlowJourney() {
        await this.gatewayHealthAndRestJourney();
        // 1. Auth GoTrue Health check via NGINX gateway (/auth/v1/health)
        await this.step('auth_health', () => this.request('GET', '/auth/v1/health'));
        // 2. Auth GoTrue Settings (/auth/v1/settings)
        await this.step('auth_settings', () => this.request('GET', '/auth/v1/settings'));
        // 3. User Signup Attempt
        const user = TestUserManager.getNextTestUser();
        await this.step('auth_signup', () => this.request('POST', '/auth/v1/signup', {
            email: user.email,
            password: user.password
        }));
    }
    async fullStorefrontWorkflow() {
        await this.authFlowJourney();
        // Query REST API for schema/tables
        await this.step('rest_schema_query', () => this.request('GET', '/rest/v1/', undefined, { 'Prefer': 'count=exact' }));
    }
    async request(method, path, body, headers = {}) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const opts = {
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
            const response = await fetch(`${this.baseUrl}${path}`, opts);
            clearTimeout(id);
            let data = null;
            try {
                const text = await response.text();
                data = text ? JSON.parse(text) : null;
            }
            catch (e) {
                data = null;
            }
            return { status: response.status, data };
        }
        catch (err) {
            clearTimeout(id);
            throw err;
        }
    }
    async step(actionName, fn) {
        const start = Date.now();
        try {
            const res = await fn();
            const latency = Date.now() - start;
            const statusCode = res?.status || 200;
            const isErr = statusCode >= 400;
            this.stats.recordRequest(actionName, statusCode, latency, isErr);
        }
        catch (e) {
            const latency = Date.now() - start;
            const isTimeout = e.name === 'AbortError' || e.message?.includes('aborted');
            this.stats.recordRequest(actionName, null, latency, true, isTimeout);
        }
    }
}
//# sourceMappingURL=VertikalScenario.js.map