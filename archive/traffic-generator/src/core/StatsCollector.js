export class StatsCollector {
    targetId;
    isRunning = false;
    profileName = 'normal';
    startTime = null;
    totalRequests = 0;
    successCount = 0;
    errorCount = 0;
    timeoutCount = 0;
    totalLatencyMs = 0;
    statusCodeDistribution = {};
    actions = new Map();
    constructor(targetId) {
        this.targetId = targetId;
    }
    start(profileName) {
        this.isRunning = true;
        this.profileName = profileName;
        this.startTime = new Date().toISOString();
    }
    stop() {
        this.isRunning = false;
    }
    recordRequest(actionName, statusCode, latencyMs, error, timeout) {
        this.totalRequests++;
        this.totalLatencyMs += latencyMs;
        if (timeout) {
            this.timeoutCount++;
            this.errorCount++;
        }
        else if (error || (statusCode && statusCode >= 400)) {
            this.errorCount++;
        }
        else {
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
        if (error || (statusCode && statusCode >= 400))
            action.errorCount++;
        else
            action.successCount++;
    }
    getDiagnostics() {
        const elapsedSec = this.startTime ? (Date.now() - new Date(this.startTime).getTime()) / 1000 : 1;
        const journeysPerSec = elapsedSec > 0 ? Math.round((this.totalRequests / elapsedSec) * 10) / 10 : 0;
        const avgLatencyMs = this.totalRequests > 0 ? Math.round(this.totalLatencyMs / this.totalRequests) : 0;
        const actionStatsObj = {};
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
    reset() {
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
//# sourceMappingURL=StatsCollector.js.map