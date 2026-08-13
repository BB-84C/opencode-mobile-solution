#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const VERSION = '2';
const home = os.homedir();
const platformName = process.env.OPENCODE_MACHINE_PLATFORM
  || (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform);
const configDirectory = process.env.OPENCODE_RELAY_CONFIG_DIR || path.join(home, '.config', 'opencode-relay');
const credentialPath = process.env.OPENCODE_MACHINE_CREDENTIAL || path.join(configDirectory, 'machine.json');
const installationPath = path.join(configDirectory, 'installation-id');
const frpcPath = process.env.OPENCODE_FRPC_CONFIG || path.join(configDirectory, 'frpc.toml');
const relayOrigin = (process.env.OPENCODE_RELAY_ORIGIN || 'https://opencode.example.com').replace(/\/$/, '');
const sshAlias = process.env.OPENCODE_RELAY_SSH_ALIAS || 'opencode-vps';
const localPort = Number(process.env.OPENCODE_SERVER_PORT || 4096);
const action = process.argv[2] || 'status';

function applyUserOnlyAcl(filePath) {
  if (process.platform !== 'win32') return;
  const result = spawnSync('icacls.exe', [filePath, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`], { stdio: 'ignore' });
  if (result.status !== 0) {
    const error = new Error(`Failed to apply user-only ACL to ${filePath}`);
    error.exitCode = 10;
    throw error;
  }
}

function atomicWrite(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, value, { mode });
  fs.renameSync(temporary, filePath);
  if (process.platform === 'win32') applyUserOnlyAcl(filePath);
  else fs.chmodSync(filePath, mode);
}

function readJson(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) throw new Error(`${filePath} must have mode 600`);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function installationID() {
  try {
    const value = fs.readFileSync(installationPath, 'utf8').trim();
    if (/^[A-Za-z0-9._:-]{8,128}$/.test(value)) return value;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const value = `${platformName}:${crypto.randomUUID()}`;
  atomicWrite(installationPath, `${value}\n`);
  return value;
}

function existingFrpcRequest() {
  try {
    const value = fs.readFileSync(frpcPath, 'utf8');
    const target = value.match(/^\s*name\s*=\s*["']([^"']+)["']\s*$/m)?.[1] || null;
    const portText = value.match(/^\s*remotePort\s*=\s*(\d+)\s*$/m)?.[1];
    const port = portText ? Number(portText) : null;
    return { requestedTargetID: target, requestedRemotePort: port };
  } catch (error) {
    if (error?.code === 'ENOENT') return { requestedTargetID: null, requestedRemotePort: null };
    throw error;
  }
}

async function requestJson(pathname, { method = 'GET', token, body, timeoutMs = 10_000 } = {}) {
  let response;
  try {
    response = await fetch(`${relayOrigin}${pathname}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const wrapped = new Error(`Relay request failed: ${error.message}`);
    wrapped.exitCode = 7;
    throw wrapped;
  }
  const value = await response.json().catch(() => ({}));
  return { response, value };
}

async function credentialStatus(credential = readJson(credentialPath)) {
  if (!credential?.accessToken || credential.relayOrigin !== relayOrigin) {
    return { Status: 'Unauthorized', Machine: null, Reason: 'credential_missing' };
  }
  const { response, value } = await requestJson('/api/machine/me', { token: credential.accessToken });
  if (response.status === 401) return { Status: 'Revoked', Machine: credential.machine ?? null, Reason: value.error || 'invalid_machine_token' };
  if (!response.ok) {
    const error = new Error(value.message || value.error || `Machine status failed (${response.status})`);
    error.exitCode = 7;
    throw error;
  }
  return { Status: 'Authorized', Machine: value.machine, Reason: null };
}

function validateIssued(value) {
  if (!value || typeof value.access_token !== 'string' || value.access_token.length < 32
      || !value.machine?.machineID || !value.machine?.targetID
      || !Number.isInteger(value.transport?.remotePort)
      || typeof value.transport?.frpToken !== 'string' || value.transport.frpToken.length < 8) {
    throw new Error('Relay returned an incomplete machine credential');
  }
  return value;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function saveIssued(value) {
  const issued = validateIssued(value);
  const credential = {
    schema: 1,
    relayOrigin,
    accessToken: issued.access_token,
    machine: issued.machine,
    transport: issued.transport,
    sshAlias,
    authorizedAt: new Date().toISOString(),
  };
  atomicWrite(credentialPath, `${JSON.stringify(credential, null, 2)}\n`);
  // When the relay issues a public frps host, frpc dials the server directly and
  // the SSH local-forward layer is skipped. Without one (legacy enrollment), the
  // two-layer design is preserved: 127.0.0.1 over the SSH forward port.
  const issuedFrpsHost = typeof issued.transport?.frpServerHost === 'string' && issued.transport.frpServerHost.length > 0
    ? issued.transport.frpServerHost
    : '127.0.0.1';
  const frpcServerPort = issuedFrpsHost === '127.0.0.1'
    ? Number(issued.transport.localForwardPort || 17000)
    : Number(issued.transport.frpServerPort || 7000);
  const frpc = [
    `serverAddr = ${tomlString(issuedFrpsHost)}`,
    `serverPort = ${frpcServerPort}`,
    '',
    'auth.method = "token"',
    `auth.token = ${tomlString(issued.transport.frpToken)}`,
    '',
    '[[proxies]]',
    `name = ${tomlString(issued.machine.targetID)}`,
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    `localPort = ${localPort}`,
    `remotePort = ${Number(issued.transport.remotePort)}`,
    '',
  ].join('\n');
  atomicWrite(frpcPath, frpc);
  return credential;
}

async function authorize() {
  const username = process.env.OPENCODE_SERVER_USERNAME || '';
  const password = process.env.OPENCODE_SERVER_PASSWORD || '';
  if (!username || password.length < 16) {
    const error = new Error('Local OpenCode Basic credentials are missing or too short');
    error.exitCode = 10;
    throw error;
  }
  const previous = readJson(credentialPath);
  const frpc = existingFrpcRequest();
  const displayName = process.env.OPENCODE_MACHINE_NAME || os.hostname();
  const { response, value } = await requestJson('/api/oauth/device/code', {
    method: 'POST',
    body: {
      installationID: installationID(),
      displayName,
      hostname: os.hostname(),
      platform: platformName,
      clientVersion: VERSION,
      basicUsername: username,
      basicPassword: password,
      requestedTargetID: previous?.machine?.targetID || process.env.OPENCODE_RELAY_REQUESTED_TARGET || frpc.requestedTargetID,
      requestedRemotePort: previous?.transport?.remotePort || (Number(process.env.OPENCODE_RELAY_REQUESTED_PORT) || null) || frpc.requestedRemotePort,
    },
  });
  if (!response.ok) {
    const error = new Error(value.message || value.error || `Machine authorization failed (${response.status})`);
    error.exitCode = response.status === 429 ? 7 : 10;
    throw error;
  }
  if (!value.device_code || !value.verification_uri_complete || !value.user_code) {
    throw new Error('Relay returned an incomplete device authorization');
  }
  process.stderr.write(`Open this URL to authorize ${displayName}:\n${value.verification_uri_complete}\nCode: ${value.user_code}\n`);
  if (process.env.OPENCODE_RELAY_NO_OPEN !== '1') {
    // rundll32's FileProtocolHandler opens the default browser without any shell
    // quoting pitfalls (pwsh -Command with a string does not receive $args).
    const opened = process.platform === 'win32'
      ? spawnSync('rundll32.exe', ['url.dll,FileProtocolHandler', value.verification_uri_complete], { stdio: 'ignore' })
      : spawnSync('/usr/bin/open', [value.verification_uri_complete], { stdio: 'ignore' });
    if (opened.status !== 0) process.stderr.write('The browser could not be opened automatically; use the URL above.\n');
  }

  let intervalMs = Math.max(1_000, Number(value.interval || 5) * 1_000);
  const deadline = Date.now() + Math.max(60, Number(value.expires_in || 600)) * 1_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const polled = await requestJson('/api/oauth/token', {
      method: 'POST',
      body: { device_code: value.device_code },
    });
    if (polled.response.ok) return saveIssued(polled.value);
    if (polled.value.error === 'authorization_pending') continue;
    if (polled.value.error === 'slow_down') {
      intervalMs += 1_000;
      continue;
    }
    const error = new Error(polled.value.error_description || polled.value.message || polled.value.error || `Token request failed (${polled.response.status})`);
    error.exitCode = polled.value.error === 'access_denied' ? 6 : 7;
    throw error;
  }
  const error = new Error('Machine authorization expired before it was approved');
  error.exitCode = 7;
  throw error;
}

async function ensure() {
  const credential = readJson(credentialPath);
  if (credential) {
    const status = await credentialStatus(credential);
    if (status.Status === 'Authorized') return status;
  }
  const issued = await authorize();
  return { Status: 'Authorized', Machine: issued.machine, Reason: null };
}

try {
  let result;
  if (action === 'status') result = await credentialStatus();
  else if (action === 'ensure') result = await ensure();
  else throw Object.assign(new Error(`Unsupported machine auth action: ${action}`), { exitCode: 10 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.Status === 'Unauthorized') process.exitCode = 3;
  else if (result.Status === 'Revoked') process.exitCode = 6;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error.exitCode || 10;
}
