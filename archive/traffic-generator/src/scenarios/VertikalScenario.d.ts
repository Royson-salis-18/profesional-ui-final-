import { StatsCollector } from '../core/StatsCollector.js';
export declare class VertikalScenario {
    private baseUrl;
    private stats;
    private timeoutMs;
    constructor(baseUrl: string, stats: StatsCollector, timeoutMs?: number);
    executeJourney(): Promise<void>;
    private gatewayHealthAndRestJourney;
    private authFlowJourney;
    private fullStorefrontWorkflow;
    private request;
    private step;
}
