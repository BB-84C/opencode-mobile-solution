import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const hostDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(hostDir, 'uninstall-macos.sh');

const plan = (...args) =>
  execFileSync('bash', [script, '--dry-run', ...args], { encoding: 'utf8', cwd: hostDir });

const launchdLines = (output) =>
  output.split('\n').filter((line) => line.includes('will unload launchd job'));

const installedJobs = () => {
  try {
    return execFileSync('launchctl', ['list'], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => /com\.skylerhu\.cockpit-/.test(line));
  } catch {
    return [];
  }
};

test('tearing down a shadow stack unloads no launchd job', () => {
  // This is the outage. Shadow runs under nohup and installs no launchd job, so
  // selecting jobs by label prefix found the production relay instead: a shadow
  // teardown took the live stack off the air and deleted its plist.
  const output = plan('--mode', 'shadow');

  assert.deepEqual(
    launchdLines(output),
    [],
    `shadow teardown planned to unload a launchd job:\n${output}`,
  );
});

test('a shadow teardown addresses the shadow port and config, not the live ones', () => {
  const output = plan('--mode', 'shadow');

  assert.match(output, /serve port : 8444/);
  assert.match(output, /config dir : .*opencode-cockpit-shadow/);
  assert.ok(!/serve port : 8443/.test(output), 'shadow must not touch the live serve port');
});

test('a production teardown still finds the job it installed', (t) => {
  // Keeps the test above honest: if production also unloaded nothing, the first
  // assertion would pass for the wrong reason.
  if (installedJobs().length === 0) {
    t.skip('no cockpit launchd job on this machine to enumerate');
    return;
  }

  assert.ok(
    launchdLines(plan('--mode', 'production')).length > 0,
    'production teardown should plan to unload the installed relay job',
  );
});
