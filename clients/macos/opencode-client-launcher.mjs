import { spawn, spawnSync } from 'node:child_process';

const required = [
  'OPENCODE_REAL_CMD',
  'OPENCODE_CONTROLLER',
  'OPENCODE_CLIENT_DIRECTORY',
  'OPENCODE_CLIENT_GENERATION',
  'OPENCODE_SERVER_USERNAME',
  'OPENCODE_SERVER_PASSWORD',
];
for (const name of required) {
  if (!process.env[name]) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(10);
  }
}

const child = spawn(process.env.OPENCODE_REAL_CMD, process.argv.slice(2), {
  stdio: 'inherit',
  shell: false,
  env: process.env,
});

let lease;
let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  if (lease) {
    spawnSync(process.env.OPENCODE_CONTROLLER, [
      '__unregister',
      String(lease.pid),
      lease.created,
    ], {
      stdio: 'ignore',
      env: process.env,
    });
  }
  process.exit(code);
};

child.once('spawn', () => {
  const registered = spawnSync(process.env.OPENCODE_CONTROLLER, [
    '__register',
    String(child.pid),
    process.env.OPENCODE_CLIENT_GENERATION,
    process.env.OPENCODE_CLIENT_DIRECTORY,
  ], {
    encoding: 'utf8',
    env: process.env,
  });
  if (registered.status !== 0) {
    try { child.kill('SIGTERM'); } catch {}
    process.stderr.write(registered.stderr || 'Relay lease registration failed.\n');
    return;
  }
  try {
    lease = JSON.parse(registered.stdout.trim());
  } catch {
    try { child.kill('SIGTERM'); } catch {}
    process.stderr.write('Relay lease registration returned invalid state.\n');
  }
});

child.once('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  finish(10);
});

child.once('exit', (code, signal) => {
  const signalCodes = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 };
  finish(code ?? signalCodes[signal] ?? 1);
});

for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try { child.kill(signal); } catch {}
  });
}
