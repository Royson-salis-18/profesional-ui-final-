import { StatsCollector } from '../core/StatsCollector.js';
export declare class SockShopScenario {
    private baseUrl;
    private stats;
    private timeoutMs;
    constructor(baseUrl: string, stats: StatsCollector, timeoutMs?: number);
    executeJourney(): Promise<void>;
    private browseCatalogJourney;
    private shoppingCartJourney;
    private userCheckoutJourney;
    private request;
    private step;
}
