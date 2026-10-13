import { getConfig, PROFILES } from '../config/index.js';
import { StatsCollector } from './StatsCollector.js';
import { SockShopScenario } from '../scenarios/SockShopScenario.js';
import { VertikalScenario } from '../scenarios/VertikalScenario.js';
export class TrafficEngine {
    targetId;
    isRunning = false;
    profile;
    stats;
    timer = null;
    baseUrl;
    sockShopScenario = null;
    vertikalScenario = null;
    constructor(targetId, customBaseUrl, profileName = 'normal') {
        this.targetId = targetId;
        this.profile = PROFILES[profileName] || PROFILES.normal;
        this.stats = new StatsCollector(targetId);
        const config = getConfig();
        if (targetId.includes('sock') || targetId.includes('sock-shop')) {
            this.baseUrl = customBaseUrl || config.sockShopBaseUrl;
            this.sockShopScenario = new SockShopScenario(this.baseUrl, this.stats, config.timeoutMs);
        }
        else {
            this.baseUrl = customBaseUrl || config.vertikalBaseUrl;
            this.vertikalScenario = new VertikalScenario(this.baseUrl, this.stats, config.timeoutMs);
        }
    }
    start(profileName) {
        if (this.isRunning)
            return;
        if (profileName && PROFILES[profileName]) {
            this.profile = PROFILES[profileName];
        }
        if (this.profile.name === 'stress' && !this.profile.allowStress) {
            console.warn('[TrafficEngine] Stress profile requested but disabled. Falling back to moderate.');
            this.profile = PROFILES.moderate;
        }
        this.isRunning = true;
        this.stats.start(this.profile.name);
        console.log(`[TrafficEngine] Started traffic for ${this.targetId} -> ${this.baseUrl} (Profile: ${this.profile.name}, Concurrency: ${this.profile.concurrency})`);
        // Worker loop
        this.runLoop();
    }
    stop() {
        this.isRunning = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.stats.stop();
        console.log(`[TrafficEngine] Stopped traffic for ${this.targetId}`);
    }
    async runLoop() {
        if (!this.isRunning)
            return;
        const workers = [];
        for (let i = 0; i < this.profile.concurrency; i++) {
            workers.push(this.executeWorkerStep());
        }
        await Promise.all(workers);
        if (this.isRunning) {
            this.timer = setTimeout(() => this.runLoop(), this.profile.delayMs);
        }
    }
    async executeWorkerStep() {
        if (!this.isRunning)
            return;
        try {
            if (this.sockShopScenario) {
                await this.sockShopScenario.executeJourney();
            }
            else if (this.vertikalScenario) {
                await this.vertikalScenario.executeJourney();
            }
        }
        catch (e) {
            // Handled inside scenarios
        }
    }
    getDiagnostics() {
        return this.stats.getDiagnostics();
    }
}
//# sourceMappingURL=TrafficEngine.js.map