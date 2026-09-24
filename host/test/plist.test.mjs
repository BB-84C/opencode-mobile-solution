import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { renderLaunchAgent } from '../lib/plist.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const base = {
  label: 'com.example.cockpit-relay',
  programArguments: ['/bin/bash', '/Users/someone/.config/cockpit/run-relay.sh'],
  standardOutPath: '/Users/someone/.config/cockpit/logs/relay.log',
  standardErrorPath: '/Users/someone/.config/cockpit/logs/relay.log',
};

test('emits the supervision keys that keep a service alive across crashes and reboots', () => {
  const plist = renderLaunchAgent(base);

  assert.match(plist, /<key>RunAtLoad<\/key>\s*\n\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*\n\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*\n\s*<integer>10<\/integer>/);
});

test('never emits ProcessType, whatever the caller asks for', () => {
  const plist = renderLaunchAgent({ ...base, processType: 'Background' });

  // Background puts the job in a throttled band. A Node service under it was
  // measured needing over 90 seconds to bind its port, which reads as a hang.
  assert.doesNotMatch(plist, /ProcessType/);
});

test('produces a plist that macOS itself can parse', () => {
  const plist = renderLaunchAgent(base);
  const parsed = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: plist,
    encoding: 'utf8',
  });

  const job = JSON.parse(parsed);
  assert.equal(job.Label, base.label);
  assert.deepEqual(job.ProgramArguments, base.programArguments);
  assert.equal(job.KeepAlive, true);
});

test('carries an environment into a job that cannot read a login shell', () => {
  const plist = renderLaunchAgent({
    ...base,
    environment: { OMO_PROFILE: 'gpt', PATH: '/usr/bin:/bin' },
  });
  const job = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: plist,
    encoding: 'utf8',
  }));

  // launchd starts jobs with an almost empty environment, so a service that
  // needs PATH or a profile selector must carry it here or be given it by the
  // script it runs.
  assert.equal(job.EnvironmentVariables.OMO_PROFILE, 'gpt');
  assert.equal(job.EnvironmentVariables.PATH, '/usr/bin:/bin');
});

test('escapes values that would otherwise break the XML', () => {
  const plist = renderLaunchAgent({
    ...base,
    programArguments: ['/bin/bash', '/tmp/a & b/run <script>.sh'],
  });
  const job = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: plist,
    encoding: 'utf8',
  }));

  assert.equal(job.ProgramArguments[1], '/tmp/a & b/run <script>.sh');
});

test('refuses an incomplete job rather than writing one that fails at load time', () => {
  assert.throws(() => renderLaunchAgent({ ...base, label: '' }), /label is required/);
  assert.throws(() => renderLaunchAgent({ ...base, programArguments: [] }), /non-empty array/);
  assert.throws(() => renderLaunchAgent({ ...base, standardOutPath: '' }), /log paths/);
});

test('is runnable as a CLI so shell scripts do not hand-roll XML', () => {
  const out = execFileSync(process.execPath, [
    path.join(here, '..', 'lib', 'plist.mjs'),
    JSON.stringify(base),
  ], { encoding: 'utf8' });

  assert.match(out, /<key>Label<\/key>/);
  assert.doesNotMatch(out, /ProcessType/);
});
