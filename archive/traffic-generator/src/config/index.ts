export interface TrafficProfile {
  name: 'baseline' | 'moderate' | 'heavy' | 'stress' | 'ramp';
  concurrency: number;
  delayMs: number; // Delay between loop iterations in ms
  rateLimitPerSec: number;
  allowStress: boolean;
}

export const PROFILES: Record<string, TrafficProfile> = {
  baseline: {
    name: 'baseline',
    concurrency: 2,
    delayMs: 1000,
    rateLimitPerSec: 2,
    allowStress: false,
  },
  moderate: {
    name: 'moderate',
    concurrency: 5,
    delayMs: 200,
    rateLimitPerSec: 10,
    allowStress: false,
  },
  heavy: {
    name: 'heavy',
    concurrency: 15,
    delayMs: 100,
    rateLimitPerSec: 25,
    allowStress: false,
  },
  stress: {
    name: 'stress',
    concurrency: 50,
    delayMs: 20,
    rateLimitPerSec: 50, // Hard ceiling for AWS instance safety
    allowStress: true,
  },
  ramp: {
    name: 'ramp',
    concurrency: 2,
    delayMs: 500,
    rateLimitPerSec: 2, // Starts low, increased dynamically
    allowStress: true,
  },
  normal: { // Legacy fallback
    name: 'baseline',
    concurrency: 2,
    delayMs: 1000,
    rateLimitPerSec: 2,
    allowStress: false,
  }
};

export interface TrafficConfig {
  sockShopBaseUrl: string;
  vertikalBaseUrl: string;
  defaultProfile: TrafficProfile;
  timeoutMs: number;
  maxRetries: number;
  mapperUrl: string;
}

export function getConfig(): TrafficConfig {
  return {
    sockShopBaseUrl: process.env.SOCK_SHOP_BASE_URL || '',
    vertikalBaseUrl: process.env.VERTIKAL_BASE_URL || '',
    defaultProfile: PROFILES[process.env.TRAFFIC_PROFILE || 'normal'] || PROFILES.normal,
    timeoutMs: parseInt(process.env.TRAFFIC_TIMEOUT_MS || '5000', 10),
    maxRetries: parseInt(process.env.TRAFFIC_MAX_RETRIES || '2', 10),
    mapperUrl: process.env.MAPPER_URL || 'http://localhost:3001',
  };
}
