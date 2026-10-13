const { spawn } = require('child_process');
const bash = spawn('bash', ['--login'], { stdio: ['pipe', 'pipe', 'pipe'] });
bash.stdout.on('data', d => console.log('OUT:', d.toString()));
bash.stderr.on('data', d => console.log('ERR:', d.toString()));
bash.stdin.write('cd ..\necho ___DONE___\n');
setTimeout(() => {
  bash.stdin.write('pwd\necho ___DONE___\n');
}, 500);
setTimeout(() => process.exit(0), 1000);
