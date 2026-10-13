import { PROFILES, getConfig } from '../src/config/index.js';
import { StatsCollector } from '../src/core/StatsCollector.js';
import { TestUserManager } from '../src/core/TestUserManager.js';
import { TrafficEngine } from '../src/core/TrafficEngine.js';
import assert from 'assert';

async function runTests() {
  console.log('--- Running Traffic Generator Unit Tests ---');

  // Test 1: Traffic Profiles
  assert.strictEqual(PROFILES.normal.concurrency, 2, 'Normal profile concurrency should be 2');
  assert.strictEqual(PROFILES.moderate.concurrency, 5, 'Moderate profile concurrency should be 5');
  assert.strictEqual(PROFILES.stress.allowStress, false, 'Stress profile should be disabled by default');
  console.log('✓ Test 1: Profiles configuration verified');

  // Test 2: TestUserManager
  const u1 = TestUserManager.getDeterministicUser(1);
  assert.strictEqual(u1.username, 'traffic_user_1', 'Deterministic username should match');
  assert.strictEqual(u1.email, 'traffic_user_1@traffic-test.local', 'Deterministic email should match');
  console.log('✓ Test 2: TestUserManager accounts verified');

  // Test 3: StatsCollector Diagnostics
  const stats = new StatsCollector('sock-shop-aws');
  stats.start('normal');
  stats.recordRequest('homepage', 200, 45, false);
  stats.recordRequest('catalogue', 200, 60, false);
  stats.recordRequest('cart', 500, 120, true);

  const diag = stats.getDiagnostics();
  assert.strictEqual(diag.targetId, 'sock-shop-aws');
  assert.strictEqual(diag.totalRequests, 3);
  assert.strictEqual(diag.successCount, 2);
  assert.strictEqual(diag.errorCount, 1);
  assert.strictEqual(diag.statusCodeDistribution[200], 2);
  assert.strictEqual(diag.statusCodeDistribution[500], 1);
  console.log('✓ Test 3: StatsCollector diagnostic calculations verified');

  // Test 4: Traffic Engine Lifecycle
  const engine = new TrafficEngine('vertikal-aws', 'http://localhost:54321', 'normal');
  engine.start('normal');
  assert.strictEqual(engine.getDiagnostics().isRunning, true, 'Engine should be running');
  engine.stop();
  assert.strictEqual(engine.getDiagnostics().isRunning, false, 'Engine should be stopped');
  console.log('✓ Test 4: TrafficEngine lifecycle verified');

  console.log('All 4 unit tests passed successfully!');
}

runTests().catch(err => {
  console.error('Test failure:', err);
  process.exit(1);
});
