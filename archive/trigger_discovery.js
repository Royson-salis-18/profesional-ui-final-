import { EndpointDiscoveryEngine } from './server/discovery/EndpointDiscoveryEngine.js';
import { EndpointRegistry } from './server/registry/EndpointRegistry.js';
import { config } from './server/config.js';

const registry = new EndpointRegistry();
const engine = new EndpointDiscoveryEngine(registry);
await engine.discoverTarget('sock-shop');
console.log('Discovery complete.');
