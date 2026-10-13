import { StatsCollector } from './StatsCollector.js';
export declare class TrafficEngine {
    targetId: string;
    private isRunning;
    private profile;
    stats: StatsCollector;
    private timer;
    private baseUrl;
    private sockShopScenario;
    private vertikalScenario;
    constructor(targetId: string, customBaseUrl?: string, profileName?: string);
    start(profileName?: string): void;
    stop(): void;
    private runLoop;
    private executeWorkerStep;
    getDiagnostics(): import("./StatsCollector.js").GeneratorDiagnostics;
}
