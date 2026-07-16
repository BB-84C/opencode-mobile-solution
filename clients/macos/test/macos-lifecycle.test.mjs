import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const execute = promisify(execFile);
const macosRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const orchestrator = path.join(macosRoot, 'opencode-relay-server');
const launcher = path.join(macosRoot, 'opencode-launch');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-lifecycle-'));
  cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
  const bin = path.join(home, '.local', 'bin');
  const lib = path.join(home, '.local', 'lib', 'opencode-relay');
  const stateRoot = path.join(home, '.local', 'state', 'opencode-relay');
  await Promise.all([bin, lib, stateRoot].map((directory) => fs.mkdir(directory, { recursive: true })));
  const statePath = path.join(home, 'fake-state.json');
  const logPath = path.join(home, 'fake-log.txt');
  const initial = {
    backend: 'Ready', generation: 10, backendPid: 100,
    tunnel: 'Running', tunnelPid: 200,
    agent: 'Running', agentPid: 300,
    auth: 'Authorized', credential: 'persistent-machine-credential',
  };
  await fs.writeFile(statePath, JSON.stringify(initial));
  await fs.writeFile(path.join(lib, 'common.sh'), [
    `RELAY_NODE=${JSON.stringify(process.execPath)}`,
    `RELAY_STATE_ROOT=${JSON.stringify(stateRoot)}`,
    'OPENCODE_SERVER_USERNAME=opencode',
    'OPENCODE_SERVER_PASSWORD=test-password-with-enough-entropy',
    'relay_load_config() { return 0; }',
    '',
  ].join('\n'));

  const component = `#!/usr/bin/env node
const fs=require('node:fs'); const path=require('node:path');
const roleName=path.basename(process.argv[1]);
const role=roleName.includes('core')?'backend':roleName.includes('tunnel')?'tunnel':'agent';
const action=process.argv[2]||'status'; const p=process.env.FAKE_STATE_PATH; const log=process.env.FAKE_LOG_PATH;
const s=JSON.parse(fs.readFileSync(p,'utf8')); fs.appendFileSync(log,role+':'+action+'\\n');
if(action==='start'&&s[role]!== (role==='backend'?'Ready':'Running')){s[role]=role==='backend'?'Ready':'Running';if(role==='backend'){s.generation+=1;s.backendPid+=1}else{s[role+'Pid']+=1}}
if(action==='restart'){s[role]=role==='backend'?'Ready':'Running';if(role==='backend'){s.generation+=1;s.backendPid+=1}else{s[role+'Pid']+=1}}
if(action==='stop'&&!(role==='agent'&&process.env.FAKE_AGENT_STICKY==='1'))s[role]='Stopped';
fs.writeFileSync(p,JSON.stringify(s));
if(role==='backend')console.log(JSON.stringify({State:s.backend,Generation:s.generation,Backend:{PID:s.backendPid}}));
else console.log(JSON.stringify({Status:s[role],PID:s[role+'Pid']}));
if(action==='stop'&&role==='agent'&&process.env.FAKE_AGENT_STICKY==='1')process.exitCode=7;
`;
  for (const name of ['opencode-relay-server-core', 'opencode-frp-tunnel', 'opencode-machine-agent']) {
    const target = path.join(bin, name);
    await fs.writeFile(target, component);
    await fs.chmod(target, 0o755);
  }
  const auth = `import fs from 'node:fs';
const s=JSON.parse(fs.readFileSync(process.env.FAKE_STATE_PATH,'utf8'));
fs.appendFileSync(process.env.FAKE_LOG_PATH,'auth:'+(process.argv[2]||'status')+'\\n');
console.log(JSON.stringify({Status:s.auth,Machine:{targetID:'mac-opencode'},Credential:s.credential}));
`;
  await fs.writeFile(path.join(lib, 'opencode-machine-auth.mjs'), auth);

  const environment = { ...process.env, HOME: home, FAKE_STATE_PATH: statePath, FAKE_LOG_PATH: logPath };
  const run = async (...args) => {
    try {
      const result = await execute('/bin/zsh', [orchestrator, ...args], { env: environment });
      return { code: 0, ...result };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  const state = async () => JSON.parse(await fs.readFile(statePath, 'utf8'));
  return { run, state, statePath, logPath, environment, initial };
}

test('start is idempotent, restart rebuilds runtime only, and stop preserves authorization', async () => {
  const fixtureState = await fixture();
  const before = await fixtureState.state();

  assert.equal((await fixtureState.run('start', '--json')).code, 0);
  assert.equal((await fixtureState.run('start', '--json')).code, 0);
  const afterRepeatedStart = await fixtureState.state();
  assert.deepEqual({
    generation: afterRepeatedStart.generation,
    backendPid: afterRepeatedStart.backendPid,
    tunnelPid: afterRepeatedStart.tunnelPid,
    agentPid: afterRepeatedStart.agentPid,
  }, {
    generation: before.generation,
    backendPid: before.backendPid,
    tunnelPid: before.tunnelPid,
    agentPid: before.agentPid,
  });

  assert.equal((await fixtureState.run('stop', 'tunnel', '--json')).code, 0);
  const tunnelStopped = await fixtureState.state();
  assert.equal(tunnelStopped.backend, 'Ready');
  assert.equal(tunnelStopped.backendPid, before.backendPid);
  assert.equal(tunnelStopped.tunnel, 'Stopped');
  assert.equal(tunnelStopped.agent, 'Stopped');
  assert.equal((await fixtureState.run('start', 'tunnel', '--json')).code, 0);
  const beforeRestart = await fixtureState.state();
  assert.equal(beforeRestart.backendPid, before.backendPid);

  assert.equal((await fixtureState.run('restart', '--json')).code, 0);
  const restarted = await fixtureState.state();
  assert.equal(restarted.generation, before.generation + 1);
  assert.equal(restarted.backendPid, before.backendPid + 1);
  assert.equal(restarted.tunnelPid, beforeRestart.tunnelPid + 1);
  assert.equal(restarted.agentPid, beforeRestart.agentPid + 1);
  assert.equal(restarted.credential, before.credential);

  assert.equal((await fixtureState.run('stop', '--json')).code, 0);
  assert.equal((await fixtureState.run('stop', '--json')).code, 0);
  const stopped = await fixtureState.state();
  assert.equal(stopped.backend, 'Stopped');
  assert.equal(stopped.tunnel, 'Stopped');
  assert.equal(stopped.agent, 'Stopped');
  assert.equal(stopped.auth, 'Authorized');
  assert.equal(stopped.credential, before.credential);

  assert.equal((await fixtureState.run('start', '--json')).code, 0);
  const startedAgain = await fixtureState.state();
  assert.equal(startedAgain.backend, 'Ready');
  assert.equal(startedAgain.tunnel, 'Running');
  assert.equal(startedAgain.agent, 'Running');
  assert.equal(startedAgain.credential, before.credential);
});

test('stop never reports success while a managed component remains running', async () => {
  const fixtureState = await fixture();
  fixtureState.environment.FAKE_AGENT_STICKY = '1';
  const stopped = await fixtureState.run('stop', '--json');

  assert.equal(stopped.code, 7);
  assert.equal(JSON.parse(stopped.stdout).State, 'Degraded');
  assert.equal((await fixtureState.state()).agent, 'Running');
});

test('bare launcher bootstraps backend-only and never creates an implicit local fallback', async () => {
  const source = await fs.readFile(launcher, 'utf8');
  assert.match(source, /"\$RELAY_CONTROLLER" start backend/);
  assert.match(source, /Use `opencode --local` for the explicit escape hatch/);
  assert.doesNotMatch(source, /Starting local OpenCode/);
  assert.doesNotMatch(source, /exec env -u OPENCODE_SERVER_USERNAME[^\n]+"\$\{forward\[@\]\}"\nfi\n\nif ! relay_probe[\s\S]+exec env -u/);
});
