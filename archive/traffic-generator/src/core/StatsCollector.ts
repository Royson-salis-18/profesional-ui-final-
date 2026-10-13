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

export class StatsCollector {
  private targetId: string;
  private isRunning: boolean = false;
  private profileName: string = 'normal';
  private startTime: string | null = null;
  private totalRequests: number = 0;
  private successCount: number = 0;
  private errorCount: number = 0;
  private timeoutCount: number = 0;
  private totalLatencyMs: number = 0;
  private statusCodeDistribution: Record<number, number> = {};
  private actions: Map<string, ActionStat> = new Map();

  constructor(targetId: string) {
    this.targetId = targetId;
  }

  public start(profileName: string) {
    this.isRunning = true;
    this.profileName = profileName;
    this.startTime = new Date().toISOString();
  }

  public stop() {
    this.isRunning = false;
  }

  public recordRequest(actionName: string, statusCode: number | null, latencyMs: number, error?: boolean, timeout?: boolean) {
    this.totalRequests++;
    this.totalLatencyMs += latencyMs;

    if (timeout) {
      this.timeoutCount++;
      this.errorCount++;
    } else if (error || (statusCode && statusCode >= 400)) {
      this.errorCount++;
    } else {
      this.successCount++;
    }

    if (statusCode) {
      this.statusCodeDistribution[statusCode] = (this.statusCodeDistribution[statusCode] || 0) + 1;
    }

    let action = this.actions.get(actionName);
    if (!action) {
      action = { actionName, totalRequests: 0, successCount: 0, errorCount: 0, totalLatencyMs: 0 };
      this.actions.set(actionName, action);
    }
    action.totalRequests++;
    action.totalLatencyMs += latencyMs;
    if (error || (statusCode && statusCode >= 400)) action.errorCount++;
    else action.successCount++;
  }

  public getDiagnostics(): GeneratorDiagnostics {
    const elapsedSec = this.startTime ? (Date.now() - new Date(this.startTime).getTime()) / 1000 : 1;
    const journeysPerSec = elapsedSec > 0 ? Math.round((this.totalRequests / elapsedSec) * 10) / 10 : 0;
    const avgLatencyMs = this.totalRequests > 0 ? Math.round(this.totalLatencyMs / this.totalRequests) : 0;

    const actionStatsObj: Record<string, ActionStat> = {};
    for (const [k, v] of this.actions.entries()) {
      actionStatsObj[k] = { ...v };
    }

    return {
      targetId: this.targetId,
      isRunning: this.isRunning,
      profileName: this.profileName,
      startTime: this.startTime,
      totalRequests: this.totalRequests,
      successCount: this.successCount,
      errorCount: this.errorCount,
      timeoutCount: this.timeoutCount,
      avgLatencyMs,
      journeysPerSec,
      statusCodeDistribution: { ...this.statusCodeDistribution },
      actions: actionStatsObj,
    };
  }

  public reset() {
    this.totalRequests = 0;
    this.successCount = 0;
    this.errorCount = 0;
    this.timeoutCount = 0;
    this.totalLatencyMs = 0;
    this.statusCodeDistribution = {};
    this.actions.clear();
    this.startTime = null;
  }
}
