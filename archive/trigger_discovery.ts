import { EndpointDiscoveryEngine } from './server/discovery/EndpointDiscoveryEngine.js';
import { EndpointRegistry } from './server/registry/EndpointRegistry.js';

const registry = new EndpointRegistry();
const engine = new EndpointDiscoveryEngine(registry);
engine.discoverTarget('sock-shop').then(() => console.log('Discovery complete.')).catch(console.error);
