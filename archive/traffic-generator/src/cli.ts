import { parseArgs } from 'util';
import { TrafficEngine } from './core/TrafficEngine.js';
import { getConfig } from './config/index.js';

function main() {
  const { values } = parseArgs({
    options: {
      target: { type: 'string', short: 't', default: 'all' },
      url: { type: 'string', short: 'u' },
      profile: { type: 'string', short: 'p', default: 'normal' },
      mode: { type: 'string', short: 'm', default: 'USER_JOURNEY' },
      route: { type: 'string', short: 'r' },
      service: { type: 'string', short: 's' },
      endpoint: { type: 'string', short: 'e' },
      duration: { type: 'string', short: 'd', default: '0' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(`
Microservice Mapper — Traffic Generator Subsystem

Options:
  -t, --target   Target identification (sock-shop | vertikal | all) [default: all]
  -u, --url      Override target base URL
  -p, --profile  Traffic profile (baseline | moderate | heavy | stress | ramp) [default: baseline]
  -m, --mode     Traffic mode (USER_JOURNEY | ENDPOINT | SERVICE) [default: USER_JOURNEY]
  -r, --route    Specific target route (e.g., /catalogue)
  -s, --service  Specific target service filter (e.g., catalogue)
  -e, --endpoint Discovered public endpoint ID
  -d, --duration Run duration in seconds (0 = continuous) [default: 0]
  -h, --help     Show this help menu
    `);
    process.exit(0);
  }

  const config = getConfig();
  const target = (values.target || 'all').toLowerCase();
  const profile = (values.profile || 'baseline').toLowerCase();
  const mode = (values.mode || 'USER_JOURNEY').toUpperCase();
  const durationSec = parseInt(values.duration || '0', 10);

  const engines: TrafficEngine[] = [];

  if (target === 'sock-shop' || target === 'sockshop' || target === 'sock-shop-aws' || target === 'all') {
    const url = values.url || config.sockShopBaseUrl;
    engines.push(new TrafficEngine('sock-shop', url, profile, mode, values.route, values.service, values.endpoint));
  }

  if (target === 'vertikal' || target === 'vertikal-aws' || target === 'all') {
    const url = values.url || config.vertikalBaseUrl;
    engines.push(new TrafficEngine('vertikal', url, profile, mode, values.route, values.service, values.endpoint));
  }

  console.log(`====================================================`);
  console.log(` Microservice Mapper — Traffic Generator Subsystem`);
  console.log(` Target(s) : ${engines.map(e => e.targetId).join(', ')}`);
  console.log(` Mode      : ${mode}`);
  console.log(` Profile   : ${profile}`);
  if (values.route) console.log(` Route     : ${values.route}`);
  if (values.service) console.log(` Service   : ${values.service}`);
  console.log(` Duration  : ${durationSec > 0 ? `${durationSec}s` : 'Continuous (Press Ctrl+C to stop)'}`);
  console.log(`====================================================\n`);

  for (const engine of engines) {
    engine.start(profile);
  }

  const diagInterval = setInterval(() => {
    for (const engine of engines) {
      const diag = engine.getDiagnostics();
      const statsObj = {
        attempted: diag.totalRequests,
        completed: diag.successCount + diag.errorCount,
        successful: diag.successCount,
        failed: diag.errorCount,
        timeouts: 0, // not specifically tracked yet
        duration: durationSec,
        peakRate: diag.journeysPerSec
      };
      console.log(`__STATS__${engine.targetId}::${JSON.stringify(statsObj)}`);
      // Also print human readable
      console.log(`[${diag.targetId}] Rate: ${diag.journeysPerSec} req/s | Success: ${diag.successCount} | Errors: ${diag.errorCount}`);
    }
  }, 1000);

  const shutdown = () => {
    console.log('\nStopping traffic engines...');
    clearInterval(diagInterval);
    for (const engine of engines) {
      engine.stop();
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (durationSec > 0) {
    setTimeout(shutdown, durationSec * 1000);
  }
}

main();
