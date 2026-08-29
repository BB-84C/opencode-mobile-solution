#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectRelayStatus } from './relay-status-contract.mjs';

const home = os.homedir();
const configDirectory = process.env.OPENCODE_RELAY_CONFIG_DIR || path.join(home, '.config', 'opencode-relay');
const credentialPath = process.env.OPENCODE_MACHINE_CREDENTIAL || path.join(configDirectory, 'machine.json');
const statusPath = process.env.OPENCODE_MACHINE_AGENT_STATUS
  || path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'opencode-relay-server', 'machine-agent-status.json');
const stopSentinelPath = process.env.OPENCODE_MACHINE_AGENT_STOP || path.join(path.dirname(statusPath), 'machine-agent-stop.request');
const localPort = Number(process.env.OPENCODE_SERVER_PORT || 4096);
const username = process.env.OPENCODE_SERVER_USERNAME || '';
const password = process.env.OPENCODE_SERVER_PASSWORD || '';
const intervalMs = Math.max(10_000, Number(process.env.OPENCODE_MACHINE_HEARTBEAT_MS || 30_000));
let stopping = false;
let revoked = false;
let stoppedBySentinel = false;
let wakeSleep = null;

function applyUserOnlyAcl(filePath) {
  if (process.platform !== 'win32') return;
  const result = spawnSync('icacls.exe', [filePath, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`], { stdio: 'ignore', windowsHide: true });
  if (result.status !== 0) {
    const error = new Error(`Failed to apply user-only ACL to ${filePath}`);
    error.exitCode = 10;
    throw error;
  }
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, value, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  if (process.platform === 'win32') applyUserOnlyAcl(filePath);
  else fs.chmodSync(filePath, 0o600);
}

function credential() {
  const stat = fs.statSync(credentialPath);
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) throw new Error('Machine credential must have mode 600');
  const value = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
  if (!value?.relayOrigin || !value?.accessToken) throw new Error('Machine credential is incomplete');
  return value;
}

async function localHealth() {
  try {
    const authorization = Buffer.from(`${username}:${password}`).toString('base64');
    const response = await fetch(`http://127.0.0.1:${localPort}/global/health`, {
      headers: { Authorization: `Basic ${authorization}` },
      signal: AbortSignal.timeout(3_000),
    });
    const value = await response.json().catch(() => ({}));
    return {
      localHealth: response.status === 200 && value.healthy === true,
      opencodeVersion: typeof value.version === 'string' ? value.version : 'unknown',
      lastError: response.ok ? null : `local_health_http_${response.status}`,
    };
  } catch (error) {
    return { localHealth: false, opencodeVersion: 'unknown', lastError: error.message.slice(0, 200) };
  }
}

async function heartbeat(lifecycle = 'running') {
  const configuration = credential();
  const health = await localHealth();
  let response;
  try {
    response = await fetch(`${configuration.relayOrigin}/api/machine/heartbeat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${configuration.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...health, lifecycle, controllerVersion: '2' }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    atomicWrite(statusPath, `${JSON.stringify({ schema: 1, status: 'RelayUnavailable', localHealth: health.localHealth, relayStatus: projectRelayStatus(null), relayStatusObservedAt: null, lastError: error.message, updatedAt: new Date().toISOString() })}\n`);
    return;
  }
  const value = await response.json().catch(() => ({}));
  const relayStatusObservedAt = new Date().toISOString();
  const relayStatus = projectRelayStatus(value.relayStatus);
  if (response.status === 401) {
    atomicWrite(statusPath, `${JSON.stringify({ schema: 1, status: 'Revoked', localHealth: health.localHealth, relayStatus, relayStatusObservedAt, lastError: value.message || value.error, updatedAt: new Date().toISOString() })}\n`);
    process.exitCode = 6;
    revoked = true;
    stopping = true;
    return;
  }
  const status = response.ok ? (lifecycle === 'stopped' ? 'Stopped' : 'Ready') : 'RelayError';
  atomicWrite(statusPath, `${JSON.stringify({ schema: 1, status, localHealth: health.localHealth, relayStatus, relayStatusObservedAt, relayHTTP: response.status, lastError: response.ok ? null : (value.message || value.error), updatedAt: new Date().toISOString() })}\n`);
}

async function sleepUntilHeartbeat() {
  let remainingMs = intervalMs;
  while (!stopping && remainingMs > 0) {
    if (fs.existsSync(stopSentinelPath)) {
      stoppedBySentinel = true;
      stopping = true;
      break;
    }
    const sliceMs = Math.min(1_000, remainingMs);
    await new Promise((resolve) => {
      const timer = setTimeout(() => { wakeSleep = null; resolve(); }, sliceMs);
      wakeSleep = () => { clearTimeout(timer); wakeSleep = null; resolve(); };
    });
    remainingMs -= sliceMs;
  }
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    stopping = true;
    wakeSleep?.();
  });
}

try {
  if (!username || !password) throw new Error('Local OpenCode credentials are missing');
  while (!stopping) {
    await heartbeat();
    if (!stopping) await sleepUntilHeartbeat();
  }
  if (!revoked) await heartbeat('stopped');
  if (stoppedBySentinel) {
    try {
      fs.rmSync(stopSentinelPath, { force: true });
    } catch {
      // The sentinel is best-effort cleanup after the final stopped heartbeat.
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = process.exitCode || 10;
}
