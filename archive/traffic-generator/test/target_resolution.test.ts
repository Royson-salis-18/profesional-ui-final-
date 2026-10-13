import { TrafficController } from '../../server/traffic/TrafficController.js';
import { GraphStore } from '../../server/graph/GraphStore.js';
import assert from 'assert';

async function testTargetResolution() {
  console.log('--- Running Target Resolution & Safety Test Suite ---');

  const graphStore = new GraphStore();
  const controller = new TrafficController(graphStore);

  process.env.SOCK_SHOP_BASE_URL = 'http://198.51.100.1:80';
  process.env.VERTIKAL_BASE_URL = 'http://198.51.100.2:54321';

  // Test 1: Sock Shop resolution
  const sockShopUrl = controller.resolveBaseUrl('sock-shop');
  assert.strictEqual(sockShopUrl, 'http://198.51.100.1:80', 'Sock Shop URL should resolve to configured endpoint');
  console.log('✓ Test 1: Sock Shop target URL resolves correctly');

  // Test 2: Vertikal resolution
  const vertikalUrl = controller.resolveBaseUrl('vertikal');
  assert.strictEqual(vertikalUrl, 'http://198.51.100.2:54321', 'Vertikal URL should resolve to configured endpoint');
  console.log('✓ Test 2: Vertikal target URL resolves correctly');

  // Test 3: Unconfigured Target Endpoint blocks start & prohibits localhost fallback
  delete process.env.SOCK_SHOP_BASE_URL;
  delete process.env.SOCK_SHOP_AWS_BASE_URL;
  const unconfiguredUrl = controller.resolveBaseUrl('sock-shop');
  assert.strictEqual(unconfiguredUrl, null, 'Unconfigured target should return null, NOT localhost');

  const startRes = controller.startTarget('sock-shop', 'normal');
  assert.strictEqual(startRes.isRunning, false, 'Traffic start must fail if endpoint is unconfigured');
  assert.ok(startRes.error?.includes('unconfigured'), 'Error message must state target base URL is unconfigured');
  console.log('✓ Test 3: Unconfigured target blocks execution and prohibits localhost fallback');

  process.env.SOCK_SHOP_BASE_URL = 'http://198.51.100.1:80';

  // Test 4: Manual Override keeps targetId isolated
  const overrideUrl = 'http://192.168.1.100:8080';
  const resolvedOverride = controller.resolveBaseUrl('sock-shop', overrideUrl);
  assert.strictEqual(resolvedOverride, overrideUrl, 'Manual override should return specified URL');

  const overrideStartRes = controller.startTarget('sock-shop', 'normal', overrideUrl);
  assert.strictEqual(overrideStartRes.targetId, 'sock-shop', 'Target ID must remain sock-shop during override');
  assert.strictEqual(overrideStartRes.resolvedUrl, overrideUrl);
  controller.stopTarget('sock-shop');
  console.log('✓ Test 4: Manual override maintains strict targetId isolation');

  // Test 5: Target Registry Health Status in GraphStore
  const registeredTargets = Array.from(graphStore.targets.values());
  const sockTarget = registeredTargets.find(t => t.targetId === 'sock-shop');
  assert.ok(sockTarget, 'sock-shop must be registered in GraphStore targets');
  assert.ok(sockTarget.capabilities, 'Target capabilities must be present');
  console.log('✓ Test 5: Target Registry pre-registration verified');

  console.log('All 5 target resolution tests passed successfully!');
}

testTargetResolution().catch((err) => {
  console.error('Target Resolution Test Failure:', err);
  process.exit(1);
});
