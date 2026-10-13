const { spawn } = require('child_process');
const bash = spawn('bash', ['--login'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
bash.stdout.on('data', d => console.log('OUT:', d.toString()));
bash.stderr.on('data', d => console.log('ERR:', d.toString()));
bash.on('close', code => console.log('EXIT:', code));
bash.stdin.write('cd ..\necho ___CMD_DONE___$?\n');
setTimeout(() => {
  bash.stdin.write('pwd\necho ___CMD_DONE___$?\n');
}, 500);
setTimeout(() => process.exit(0), 1000);
