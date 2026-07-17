import { openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';

let out;
let err;
const close = () => {
  for (const descriptor of [out, err]) {
    if (descriptor === undefined) continue;
    try { closeSync(descriptor); } catch {}
  }
};

try {
  const input = await new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', reject);
  });
  const specification = JSON.parse(input);
  if (!specification || typeof specification.executable !== 'string'
      || !Array.isArray(specification.args)
      || ![specification.stdoutPath, specification.stderrPath]
        .every((value) => typeof value === 'string')) {
    throw new Error('invalid launch envelope');
  }
  out = openSync(specification.stdoutPath, 'a');
  err = openSync(specification.stderrPath, 'a');
  const child = spawn(specification.executable, specification.args, {
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', out, err],
    env: process.env,
  });
  child.once('spawn', () => {
    process.stdout.write(`${JSON.stringify({ pid: child.pid })}\n`);
    close();
    child.unref();
  });
  child.once('error', (error) => {
    close();
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
} catch (error) {
  close();
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
