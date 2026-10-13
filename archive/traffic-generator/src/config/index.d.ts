export interface TrafficProfile {
    name: 'normal' | 'moderate' | 'stress';
    concurrency: number;
    delayMs: number;
    journeysPerSec: number;
    allowStress: boolean;
}
export declare const PROFILES: Record<string, TrafficProfile>;
export interface TrafficConfig {
    sockShopBaseUrl: string;
    vertikalBaseUrl: string;
    defaultProfile: TrafficProfile;
    timeoutMs: number;
    maxRetries: number;
    mapperUrl: string;
}
export declare function getConfig(): TrafficConfig;
