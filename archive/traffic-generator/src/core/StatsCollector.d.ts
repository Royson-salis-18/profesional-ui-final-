export interface ActionStat {
    actionName: string;
    totalRequests: number;
    successCount: number;
    errorCount: number;
    totalLatencyMs: number;
}
export interface GeneratorDiagnostics {
    targetId: string;
    isRunning: boolean;
    profileName: string;
    startTime: string | null;
    totalRequests: number;
    successCount: number;
    errorCount: number;
    timeoutCount: number;
    avgLatencyMs: number;
    journeysPerSec: number;
    statusCodeDistribution: Record<number, number>;
    actions: Record<string, ActionStat>;
}
export declare class StatsCollector {
    private targetId;
    private isRunning;
    private profileName;
    private startTime;
    private totalRequests;
    private successCount;
    private errorCount;
    private timeoutCount;
    private totalLatencyMs;
    private statusCodeDistribution;
    private actions;
    constructor(targetId: string);
    start(profileName: string): void;
    stop(): void;
    recordRequest(actionName: string, statusCode: number | null, latencyMs: number, error?: boolean, timeout?: boolean): void;
    getDiagnostics(): GeneratorDiagnostics;
    reset(): void;
}
