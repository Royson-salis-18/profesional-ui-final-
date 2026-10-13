export const PROFILES = {
    normal: {
        name: 'normal',
        concurrency: 2,
        delayMs: 1500,
        journeysPerSec: 2,
        allowStress: false,
    },
    moderate: {
        name: 'moderate',
        concurrency: 5,
        delayMs: 800,
        journeysPerSec: 5,
        allowStress: false,
    },
    stress: {
        name: 'stress',
        concurrency: 15,
        delayMs: 200,
        journeysPerSec: 20,
        allowStress: true,
    },
};
export function getConfig() {
    return {
        sockShopBaseUrl: process.env.SOCK_SHOP_BASE_URL || 'http://localhost:80',
        vertikalBaseUrl: process.env.VERTIKAL_BASE_URL || 'http://localhost:54321',
        defaultProfile: PROFILES[process.env.TRAFFIC_PROFILE || 'normal'] || PROFILES.normal,
        timeoutMs: parseInt(process.env.TRAFFIC_TIMEOUT_MS || '5000', 10),
        maxRetries: parseInt(process.env.TRAFFIC_MAX_RETRIES || '2', 10),
        mapperUrl: process.env.MAPPER_URL || 'http://localhost:3001',
    };
}
//# sourceMappingURL=index.js.map