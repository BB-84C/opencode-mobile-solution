import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import QRCode from 'qrcode';

import { PairingStore, PairingStoreError } from './pairing-store.mjs';

const SESSION_COOKIE = 'oc_relay_session';
const MAX_BODY_BYTES = 128 * 1_024;

class HttpError extends Error {
  constructor(status, message, code = 'request_failed') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function validatePublicOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('RELAY_PUBLIC_ORIGIN must be an absolute URL');
  }
  if (url.origin !== value.replace(/\/$/, '') || (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('RELAY_PUBLIC_ORIGIN must be an HTTPS origin without a path');
  }
  return url.origin;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').flatMap((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 0) return [];
    return [[entry.slice(0, separator).trim(), decodeURIComponent(entry.slice(separator + 1).trim())]];
  }));
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large', 'body_too_large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON', 'invalid_json');
  }
}

function securityHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
}

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { ...securityHeaders('application/json; charset=utf-8'), ...headers });
  res.end(JSON.stringify(value));
}

function sendHtml(res, html) {
  res.writeHead(200, securityHeaders('text/html; charset=utf-8'));
  res.end(html);
}

function sendJavaScript(res, javascript) {
  res.writeHead(200, securityHeaders('text/javascript; charset=utf-8'));
  res.end(javascript);
}

function sourceScope(snapshot, sourceClientID) {
  const source = sourceClientID ? snapshot.clients.get(sourceClientID) : snapshot.clients.values().next().value;
  if (!source) throw new HttpError(503, 'No owner authorization template is configured', 'pairing_source_missing');
  return {
    targetID: source.targetID,
    targetIDs: [...(source.targetIDs ?? [source.targetID])],
    pinnedDirectory: source.pinnedDirectory ?? null,
    allowedDirectories: source.allowedDirectories === undefined
      ? undefined
      : source.allowedDirectories === null
        ? null
        : [...source.allowedDirectories],
  };
}

function bearerToken(req) {
  const value = req.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : '';
}

function machineTargetID(request) {
  if (request.requestedTargetID) return request.requestedTargetID;
  const slug = request.hostname.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42) || 'opencode-machine';
  return `${slug}-${request.installationID.replace(/[^a-zA-Z0-9]/g, '').slice(-8).toLowerCase()}`;
}

function allocateMachineAssignment({ request, snapshot, machines, transport }) {
  if (!transport?.frpToken) throw new HttpError(503, 'Machine transport is not configured', 'machine_transport_unavailable');
  const existing = machines.find((machine) => machine.installationID === request.installationID);
  const targetID = request.requestedTargetID || existing?.targetID || machineTargetID(request);
  const conflictingMachine = machines.find(
    (machine) => machine.targetID === targetID && machine.installationID !== request.installationID,
  );
  if (conflictingMachine) throw new HttpError(409, 'Requested target is assigned to another machine', 'target_conflict');

  const staticTarget = snapshot.targets.get(targetID);
  if (staticTarget && request.requestedRemotePort && staticTarget.port !== request.requestedRemotePort) {
    throw new HttpError(409, 'Requested port does not match the existing relay target', 'port_conflict');
  }
  const usedPorts = new Set([
    ...[...snapshot.targets.values()].map((target) => target.port),
    ...machines.filter((machine) => machine.installationID !== request.installationID).map((machine) => machine.port),
  ]);
  let remotePort = request.requestedRemotePort || staticTarget?.port || existing?.port || null;
  if (remotePort !== null && usedPorts.has(remotePort) && staticTarget?.port !== remotePort) {
    throw new HttpError(409, 'Requested relay port is already assigned', 'port_conflict');
  }
  if (remotePort === null) {
    const minimum = transport.remotePortMin ?? 4100;
    const maximum = transport.remotePortMax ?? 4199;
    for (let candidate = minimum; candidate <= maximum; candidate += 1) {
      if (!usedPorts.has(candidate)) {
        remotePort = candidate;
        break;
      }
    }
  }
  if (remotePort === null) throw new HttpError(503, 'No relay port is available', 'port_pool_exhausted');

  return {
    targetID,
    remotePort,
    displayTargetName: staticTarget?.displayName || request.displayName,
    transport: {
      type: 'frp-ssh',
      frpServerHost: '127.0.0.1',
      frpServerPort: transport.frpServerPort ?? 7000,
      localForwardPort: transport.localForwardPort ?? 17000,
      frpToken: transport.frpToken,
    },
  };
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <title>OpenCode Relay</title>
  <style>
    :root{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#f4f4f4;background:#080808;--panel:#131313;--line:#303030;--muted:#929292;--peach:#fab283;--purple:#a879e6;--green:#8ec07c;--red:#ff746c;--yellow:#e5c07b}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;padding:max(20px,env(safe-area-inset-top)) max(18px,env(safe-area-inset-right)) max(30px,env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-left))}
    main{width:min(100%,980px);margin:auto;display:grid;gap:18px}.brand{display:flex;align-items:center;gap:13px;padding:4px 2px 8px}.brand-copy{display:grid;gap:3px}
    .mark{width:48px;height:48px;border:8px solid var(--peach);border-right-color:var(--purple);border-radius:14px}
    h1,h2,h3,p{margin:0}h1{font-size:25px}h2{font-size:17px}h3{font-size:15px}p{color:var(--muted);line-height:1.5}.subtitle{font-size:13px}
    .card{display:grid;gap:14px;padding:18px;border:1px solid var(--line);border-radius:16px;background:var(--panel)}
    .section-head{display:flex;align-items:start;justify-content:space-between;gap:12px}.section-copy{display:grid;gap:5px}.count{font-size:12px;color:var(--purple)}
    button{appearance:none;border:0;border-radius:10px;padding:11px 14px;font:700 13px inherit;color:#080808;background:var(--peach);cursor:pointer;white-space:nowrap}
    button.secondary{color:#f1f1f1;background:#292929}button.danger{color:#ffaaa4;background:#301d1d}button:disabled{opacity:.5;cursor:wait}
    .grid{display:grid;gap:10px}.row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:13px;border:1px solid var(--line);border-radius:12px;background:#101010}
    .row-main{min-width:0;display:grid;gap:5px}.row-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.row-title strong{overflow-wrap:anywhere}.meta{font-size:12px;color:var(--muted);overflow-wrap:anywhere}.actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:end}
    .badge{display:inline-flex;align-items:center;gap:5px;padding:3px 7px;border-radius:999px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;background:#242424;color:#aaa}.badge.online{color:var(--green);background:#19251a}.badge.degraded{color:var(--yellow);background:#2b2618}.badge.offline,.badge.revoked{color:var(--red);background:#2b1919}.badge.stopped{color:#aaa;background:#242424}.dot{width:6px;height:6px;border-radius:50%;background:currentColor}
    .empty{padding:16px;border:1px dashed #333;border-radius:12px;color:#777;text-align:center;font-size:12px}.status{font-size:13px;color:var(--purple)}.overview{grid-template-columns:1fr auto;align-items:center}.overview-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:end}
    #qr{display:grid;place-items:center;padding:12px;border-radius:14px;background:#fff}#qr svg{width:min(100%,300px);height:auto}.pairing{width:min(100%,360px);justify-self:center;display:grid;gap:10px;text-align:center}
    .pending-focus{border-color:var(--purple);box-shadow:0 0 0 1px var(--purple)}.code{font-size:16px;letter-spacing:.08em;color:var(--peach)}
    .hidden{display:none!important}.error{color:var(--red);white-space:pre-wrap}.authenticated{display:grid;gap:18px}
    @media(max-width:640px){body{padding-left:12px;padding-right:12px}.card{padding:15px}.row,.overview{grid-template-columns:1fr}.actions,.overview-actions{justify-content:start}.section-head{align-items:center}}
  </style>
</head>
<body><main>
  <div class="brand"><div class="mark" aria-hidden="true"></div><div class="brand-copy"><h1>OpenCode Relay</h1><p class="subtitle">Passkey-protected machines and phones</p></div></div>
  <section class="card overview">
    <div class="section-copy"><div id="status" class="status">Checking passkey…</div><p id="explanation">Sign in once to manage every connected OpenCode machine and phone.</p></div>
    <div class="overview-actions"><button id="primary" disabled>Loading…</button><button id="refresh" class="secondary hidden">Refresh</button></div>
  </section>
  <div id="authenticated" class="authenticated hidden">
    <section class="card"><div class="section-head"><div class="section-copy"><h2>Pending machine authorization</h2><p>Requests from <code>opencode --relay_server start</code> expire automatically.</p></div><span id="pending-count" class="count"></span></div><div id="pending" class="grid"></div></section>
    <section class="card"><div class="section-head"><div class="section-copy"><h2>Machines</h2><p>Local OpenCode, outbound tunnel, and public reachability are checked separately.</p></div><span id="machine-count" class="count"></span></div><div id="machines" class="grid"></div></section>
    <section class="card"><div class="section-head"><div class="section-copy"><h2>Authorized phones</h2><p>Phone credentials remain valid until you revoke them here.</p></div><button id="connect-phone">Connect phone</button></div><div id="devices" class="grid"></div><div id="pairing" class="pairing hidden"><div id="qr" aria-label="Phone pairing QR code"></div><p id="expiry"></p></div></section>
  </div>
  <p id="error" class="error hidden"></p>
</main><script src="/pair/app.js?v=20260714-rename-sync-1"></script></body></html>`;
}

function mobilePairingHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><title>Connect OpenCode</title>
<style>:root{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#f1f1f1;background:#090909}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}main{width:min(100%,420px);display:grid;gap:18px;text-align:center}.mark{margin:auto;width:72px;height:72px;border:12px solid #fab283;border-right-color:#a879e6;border-radius:22px}h1{margin:0;font-size:25px}p{margin:0;color:#aaa;line-height:1.5}a{display:block;padding:15px;border-radius:12px;background:#fab283;color:#090909;text-decoration:none;font-weight:800}.error{color:#ff746c}</style></head>
<body><main><div class="mark" aria-hidden="true"></div><h1>Connect this iPhone</h1><p id="message">Opening OpenCode…</p><a id="open" href="#">Open OpenCode</a></main><script src="/pair/mobile.js?v=20260714-rename-sync-1"></script></body></html>`;
}

const legacyDashboardJavaScript = String.raw`
const statusNode = document.querySelector('#status');
const explanationNode = document.querySelector('#explanation');
const primaryButton = document.querySelector('#primary');
const qrNode = document.querySelector('#qr');
const expiryNode = document.querySelector('#expiry');
const devicesNode = document.querySelector('#devices');
const errorNode = document.querySelector('#error');
let state = null;

function base64urlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}
function bytesToBase64url(value) {
  if (!value) return undefined;
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function creationOptions(options) {
  return {
    ...options,
    challenge: base64urlToBytes(options.challenge),
    user: { ...options.user, id: base64urlToBytes(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map(item => ({ ...item, id: base64urlToBytes(item.id) })),
  };
}
function requestOptions(options) {
  return {
    ...options,
    challenge: base64urlToBytes(options.challenge),
    allowCredentials: (options.allowCredentials || []).map(item => ({ ...item, id: base64urlToBytes(item.id) })),
  };
}
function registrationResponse(credential) {
  const response = credential.response;
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: bytesToBase64url(response.clientDataJSON),
      attestationObject: bytesToBase64url(response.attestationObject),
      transports: response.getTransports ? response.getTransports() : [],
      publicKeyAlgorithm: response.getPublicKeyAlgorithm ? response.getPublicKeyAlgorithm() : undefined,
      publicKey: response.getPublicKey ? bytesToBase64url(response.getPublicKey()) : undefined,
      authenticatorData: response.getAuthenticatorData ? bytesToBase64url(response.getAuthenticatorData()) : undefined,
    },
  };
}
function authenticationResponse(credential) {
  const response = credential.response;
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      authenticatorData: bytesToBase64url(response.authenticatorData),
      clientDataJSON: bytesToBase64url(response.clientDataJSON),
      signature: bytesToBase64url(response.signature),
      userHandle: bytesToBase64url(response.userHandle),
    },
  };
}
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.message || value.error || ('Request failed (' + response.status + ')'));
  return value;
}
function renderDevices(devices) {
  devicesNode.replaceChildren();
  if (!devices || devices.length === 0) {
    devicesNode.classList.add('hidden');
    return;
  }
  devicesNode.classList.remove('hidden');
  for (const device of devices) {
    const row = document.createElement('div');
    row.className = 'device';
    const detail = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = device.displayName;
    const dates = document.createElement('small');
    dates.textContent = 'Paired ' + new Date(device.createdAt).toLocaleString() + (device.lastUsedAt ? ' · last used ' + new Date(device.lastUsedAt).toLocaleString() : '');
    detail.append(name, dates);
    const revoke = document.createElement('button');
    revoke.className = 'secondary';
    revoke.textContent = 'Revoke';
    revoke.addEventListener('click', async () => {
      if (!confirm('Revoke ' + device.displayName + '?')) return;
      revoke.disabled = true;
      try {
        await api('/api/pairing/revoke', { clientID: device.clientID });
        await loadStatus();
      } catch (error) { showError(error); }
    });
    row.append(detail, revoke);
    devicesNode.append(row);
  }
}
function setupToken() {
  const value = new URLSearchParams(location.hash.replace(/^#/, '')).get('setup');
  return value || '';
}
function showError(error) {
  errorNode.textContent = error instanceof Error ? error.message : String(error);
  errorNode.classList.remove('hidden');
  primaryButton.disabled = false;
}
async function loadStatus() {
  state = await api('/api/passkey/status');
  qrNode.classList.add('hidden');
  expiryNode.classList.add('hidden');
  if (state.authenticated) {
    statusNode.textContent = 'Passkey verified';
    explanationNode.textContent = 'Generate a one-time QR code, then scan it with your phone.';
    primaryButton.textContent = 'Connect phone';
    primaryButton.disabled = false;
    primaryButton.onclick = connectPhone;
    renderDevices(state.devices);
    return;
  }
  renderDevices([]);
  if (state.configured) {
    statusNode.textContent = 'Passkey required';
    explanationNode.textContent = 'No username or password is needed.';
    primaryButton.textContent = 'Sign in with passkey';
    primaryButton.disabled = false;
    primaryButton.onclick = signIn;
    return;
  }
  statusNode.textContent = setupToken() ? 'Ready to create owner passkey' : 'Owner passkey is not configured';
  explanationNode.textContent = setupToken() ? 'This one-time setup link will be disabled after registration.' : 'Open the private setup link generated by the relay administrator.';
  primaryButton.textContent = 'Create owner passkey';
  primaryButton.disabled = !setupToken();
  primaryButton.onclick = register;
}
async function register() {
  try {
    primaryButton.disabled = true;
    const generated = await api('/api/passkey/register/options', { setup: setupToken() });
    const credential = await navigator.credentials.create({ publicKey: creationOptions(generated.options) });
    await api('/api/passkey/register/verify', { setup: setupToken(), ceremony: generated.ceremony, response: registrationResponse(credential) });
    history.replaceState(null, '', location.pathname);
    await loadStatus();
  } catch (error) { showError(error); }
}
async function signIn() {
  try {
    primaryButton.disabled = true;
    const generated = await api('/api/passkey/auth/options', {});
    const credential = await navigator.credentials.get({ publicKey: requestOptions(generated.options) });
    await api('/api/passkey/auth/verify', { ceremony: generated.ceremony, response: authenticationResponse(credential) });
    await loadStatus();
  } catch (error) { showError(error); }
}
async function connectPhone() {
  try {
    primaryButton.disabled = true;
    const pairing = await api('/api/pairing/create', {});
    qrNode.innerHTML = pairing.qrSvg;
    qrNode.classList.remove('hidden');
    expiryNode.textContent = 'Single use · expires in 2 minutes';
    expiryNode.classList.remove('hidden');
    primaryButton.textContent = 'Generate a new code';
    primaryButton.disabled = false;
  } catch (error) { showError(error); }
}
loadStatus().catch(showError);
`;

const dashboardJavaScript = String.raw`
const nodes = {
  status: document.querySelector('#status'),
  explanation: document.querySelector('#explanation'),
  primary: document.querySelector('#primary'),
  refresh: document.querySelector('#refresh'),
  authenticated: document.querySelector('#authenticated'),
  pending: document.querySelector('#pending'),
  pendingCount: document.querySelector('#pending-count'),
  machines: document.querySelector('#machines'),
  machineCount: document.querySelector('#machine-count'),
  devices: document.querySelector('#devices'),
  connectPhone: document.querySelector('#connect-phone'),
  pairing: document.querySelector('#pairing'),
  qr: document.querySelector('#qr'),
  expiry: document.querySelector('#expiry'),
  error: document.querySelector('#error'),
};
let currentState = null;

function base64urlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}
function bytesToBase64url(value) {
  if (!value) return undefined;
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function creationOptions(options) {
  return { ...options, challenge: base64urlToBytes(options.challenge), user: { ...options.user, id: base64urlToBytes(options.user.id) }, excludeCredentials: (options.excludeCredentials || []).map(item => ({ ...item, id: base64urlToBytes(item.id) })) };
}
function requestOptions(options) {
  return { ...options, challenge: base64urlToBytes(options.challenge), allowCredentials: (options.allowCredentials || []).map(item => ({ ...item, id: base64urlToBytes(item.id) })) };
}
function registrationResponse(credential) {
  const response = credential.response;
  return { id: credential.id, rawId: bytesToBase64url(credential.rawId), type: credential.type, authenticatorAttachment: credential.authenticatorAttachment, clientExtensionResults: credential.getClientExtensionResults(), response: { clientDataJSON: bytesToBase64url(response.clientDataJSON), attestationObject: bytesToBase64url(response.attestationObject), transports: response.getTransports ? response.getTransports() : [], publicKeyAlgorithm: response.getPublicKeyAlgorithm ? response.getPublicKeyAlgorithm() : undefined, publicKey: response.getPublicKey ? bytesToBase64url(response.getPublicKey()) : undefined, authenticatorData: response.getAuthenticatorData ? bytesToBase64url(response.getAuthenticatorData()) : undefined } };
}
function authenticationResponse(credential) {
  const response = credential.response;
  return { id: credential.id, rawId: bytesToBase64url(credential.rawId), type: credential.type, authenticatorAttachment: credential.authenticatorAttachment, clientExtensionResults: credential.getClientExtensionResults(), response: { authenticatorData: bytesToBase64url(response.authenticatorData), clientDataJSON: bytesToBase64url(response.clientDataJSON), signature: bytesToBase64url(response.signature), userHandle: bytesToBase64url(response.userHandle) } };
}
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.message || value.error_description || value.error || ('Request failed (' + response.status + ')'));
  return value;
}
function setupToken() {
  return new URLSearchParams(location.hash.replace(/^#/, '')).get('setup') || '';
}
function requestedUserCode() {
  return new URL(location.href).searchParams.get('user_code') || '';
}
function showError(error) {
  nodes.error.textContent = error instanceof Error ? error.message : String(error);
  nodes.error.classList.remove('hidden');
  nodes.primary.disabled = false;
}
function clearError() {
  nodes.error.textContent = '';
  nodes.error.classList.add('hidden');
}
function empty(text) {
  const node = document.createElement('div');
  node.className = 'empty';
  node.textContent = text;
  return node;
}
function when(value) {
  if (!value) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'unknown' : date.toLocaleString();
}
function actionButton(label, className, callback) {
  const button = document.createElement('button');
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener('click', async () => {
    button.disabled = true;
    clearError();
    try { await callback(); } catch (error) { showError(error); }
    finally { button.disabled = false; }
  });
  return button;
}
function renderPending(pending) {
  nodes.pending.replaceChildren();
  nodes.pendingCount.textContent = String(pending.length);
  if (pending.length === 0) {
    nodes.pending.append(empty('No pending requests. Start relay_server on a machine to authorize it here.'));
    return;
  }
  const focus = requestedUserCode().toUpperCase();
  for (const authorization of pending) {
    const row = document.createElement('div');
    row.className = 'row' + (focus && focus === authorization.userCode ? ' pending-focus' : '');
    const main = document.createElement('div');
    main.className = 'row-main';
    const title = document.createElement('div');
    title.className = 'row-title';
    const name = document.createElement('strong');
    name.textContent = authorization.displayName;
    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = authorization.userCode;
    title.append(name, code);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = authorization.platform + ' · ' + authorization.hostname + ' · requested ' + (authorization.requestedTargetID || 'automatic target') + ' · expires ' + when(authorization.expiresAt);
    main.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      actionButton('Approve', '', async () => {
        await api('/api/machine/approve', { userCode: authorization.userCode });
        history.replaceState(null, '', location.pathname);
        await loadStatus();
      }),
      actionButton('Deny', 'secondary', async () => {
        await api('/api/machine/deny', { userCode: authorization.userCode });
        await loadStatus();
      }),
    );
    row.append(main, actions);
    nodes.pending.append(row);
  }
}
function renderMachines(machines) {
  nodes.machines.replaceChildren();
  const active = machines.filter(machine => !machine.revokedAt).length;
  nodes.machineCount.textContent = active + ' active · ' + machines.length + ' total';
  if (machines.length === 0) {
    nodes.machines.append(empty('No machine has been authorized yet.'));
    return;
  }
  for (const machine of machines) {
    const row = document.createElement('div');
    row.className = 'row';
    const main = document.createElement('div');
    main.className = 'row-main';
    const title = document.createElement('div');
    title.className = 'row-title';
    const name = document.createElement('strong');
    name.textContent = machine.displayName;
    const badge = document.createElement('span');
    const state = machine.state || (machine.revokedAt ? 'revoked' : 'offline');
    badge.className = 'badge ' + state;
    const dot = document.createElement('span');
    dot.className = 'dot';
    badge.append(dot, document.createTextNode(state));
    title.append(name, badge);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const local = machine.localHealthy ? 'local 4096 ready' : 'local 4096 unavailable';
    const publicLink = machine.publicReachable ? 'relay reachable' : 'relay unreachable';
    meta.textContent = machine.platform + ' · ' + machine.hostname + ' · ' + machine.targetID + ' :' + machine.port + ' · ' + local + ' · ' + publicLink + ' · heartbeat ' + when(machine.lastHeartbeatAt);
    main.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(actionButton('Rename', 'secondary', async () => {
      const displayName = prompt('Machine name', machine.displayName);
      if (displayName === null) return;
      await api('/api/machine/rename', { machineID: machine.machineID, displayName });
      await loadStatus();
    }));
    if (!machine.revokedAt) {
      actions.append(actionButton('Revoke', 'danger', async () => {
        if (!confirm('Revoke relay access for ' + machine.displayName + '?')) return;
        await api('/api/machine/revoke', { machineID: machine.machineID });
        await loadStatus();
      }));
    }
    row.append(main, actions);
    nodes.machines.append(row);
  }
}
function renderDevices(devices) {
  nodes.devices.replaceChildren();
  if (devices.length === 0) {
    nodes.devices.append(empty('No phone is authorized.'));
    return;
  }
  for (const device of devices) {
    const row = document.createElement('div');
    row.className = 'row';
    const main = document.createElement('div');
    main.className = 'row-main';
    const title = document.createElement('div');
    title.className = 'row-title';
    const name = document.createElement('strong');
    name.textContent = device.displayName;
    title.append(name);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = 'Authorized ' + when(device.createdAt) + ' · last used ' + when(device.lastUsedAt);
    main.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      actionButton('Rename', 'secondary', async () => {
        const displayName = prompt('Phone name', device.displayName);
        if (displayName === null) return;
        await api('/api/pairing/rename', { clientID: device.clientID, displayName });
        await loadStatus();
      }),
      actionButton('Revoke', 'danger', async () => {
        if (!confirm('Revoke ' + device.displayName + '?')) return;
        await api('/api/pairing/revoke', { clientID: device.clientID });
        await loadStatus();
      }),
    );
    row.append(main, actions);
    nodes.devices.append(row);
  }
}
async function loadStatus() {
  clearError();
  currentState = await api('/api/passkey/status');
  if (currentState.authenticated) {
    nodes.status.textContent = 'Passkey verified';
    nodes.explanation.textContent = 'Manage machine links and permanent phone authorizations.';
    nodes.primary.classList.add('hidden');
    nodes.refresh.classList.remove('hidden');
    nodes.authenticated.classList.remove('hidden');
    renderPending(currentState.pendingMachines || []);
    renderMachines(currentState.machines || []);
    renderDevices(currentState.devices || []);
    return;
  }
  nodes.authenticated.classList.add('hidden');
  nodes.refresh.classList.add('hidden');
  nodes.primary.classList.remove('hidden');
  if (currentState.configured) {
    nodes.status.textContent = requestedUserCode() ? 'Approve this machine with your passkey' : 'Passkey required';
    nodes.explanation.textContent = 'No relay username, password, or token needs to be typed.';
    nodes.primary.textContent = 'Sign in with passkey';
    nodes.primary.disabled = false;
    nodes.primary.onclick = signIn;
    return;
  }
  nodes.status.textContent = setupToken() ? 'Ready to create owner passkey' : 'Owner passkey is not configured';
  nodes.explanation.textContent = setupToken() ? 'This one-time setup link is disabled after registration.' : 'Open the private setup link generated by the relay administrator.';
  nodes.primary.textContent = 'Create owner passkey';
  nodes.primary.disabled = !setupToken();
  nodes.primary.onclick = register;
}
async function register() {
  try {
    nodes.primary.disabled = true;
    const generated = await api('/api/passkey/register/options', { setup: setupToken() });
    const credential = await navigator.credentials.create({ publicKey: creationOptions(generated.options) });
    await api('/api/passkey/register/verify', { setup: setupToken(), ceremony: generated.ceremony, response: registrationResponse(credential) });
    history.replaceState(null, '', location.pathname);
    await loadStatus();
  } catch (error) { showError(error); }
}
async function signIn() {
  try {
    nodes.primary.disabled = true;
    const generated = await api('/api/passkey/auth/options', {});
    const credential = await navigator.credentials.get({ publicKey: requestOptions(generated.options) });
    await api('/api/passkey/auth/verify', { ceremony: generated.ceremony, response: authenticationResponse(credential) });
    await loadStatus();
  } catch (error) { showError(error); }
}
async function connectPhone() {
  nodes.connectPhone.disabled = true;
  clearError();
  try {
    const pairing = await api('/api/pairing/create', {});
    nodes.qr.innerHTML = pairing.qrSvg;
    nodes.expiry.textContent = 'Single use · expires in 2 minutes';
    nodes.pairing.classList.remove('hidden');
    nodes.connectPhone.textContent = 'Generate new QR';
  } catch (error) { showError(error); }
  finally { nodes.connectPhone.disabled = false; }
}
nodes.refresh.addEventListener('click', () => loadStatus().catch(showError));
nodes.connectPhone.addEventListener('click', connectPhone);
loadStatus().catch(showError);
setInterval(() => { if (currentState?.authenticated) loadStatus().catch(showError); }, 10_000);
`;

const mobileJavaScript = String.raw`
const params = new URLSearchParams(location.hash.replace(/^#/, ''));
const code = params.get('code');
const open = document.querySelector('#open');
const message = document.querySelector('#message');
if (!code) {
  message.textContent = 'This pairing link is incomplete.';
  message.className = 'error';
  open.hidden = true;
} else {
  const deepLink = 'opencode://pair?origin=' + encodeURIComponent(location.origin) + '&code=' + encodeURIComponent(code);
  open.href = deepLink;
  open.addEventListener('click', event => { event.preventDefault(); location.href = deepLink; });
  setTimeout(() => { location.href = deepLink; }, 250);
}
`;

export function createPasskeyPairing({
  publicOrigin,
  statePath,
  bootstrapToken,
  pairingSourceClientID,
  getSnapshot,
  machineTransport = null,
  getMachineStatuses = async (machines) => machines,
  onDeviceRevoked = () => {},
  onMachineRevoked = () => {},
  store = new PairingStore({ statePath, bootstrapToken }),
}) {
  const origin = validatePublicOrigin(publicOrigin);
  const rpID = new URL(origin).hostname;
  const secureCookie = origin.startsWith('https:');
  const attempts = new Map();

  function sessionCookie(req) {
    return parseCookies(req.headers.cookie)[SESSION_COOKIE];
  }

  function isAuthenticated(req) {
    return store.authenticateWebSession(sessionCookie(req));
  }

  function requireAuthenticated(req) {
    if (!isAuthenticated(req)) throw new HttpError(401, 'Sign in with your passkey first', 'passkey_required');
  }

  function requireSameOrigin(req) {
    if (req.headers.origin !== origin) throw new HttpError(403, 'Request origin is not allowed', 'origin_forbidden');
  }

  function setSessionHeader(token) {
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secureCookie ? '; Secure' : ''}`;
  }

  function rateLimit(req, bucket, limit = 20, windowMs = 60_000) {
    const address = req.socket?.remoteAddress ?? 'unknown';
    const key = `${bucket}:${address}`;
    const now = Date.now();
    const current = attempts.get(key);
    if (!current || current.resetAt < now) {
      attempts.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    current.count += 1;
    if (current.count > limit) throw new HttpError(429, 'Too many attempts; try again shortly', 'rate_limited');
  }

  async function registerOptions(req, res) {
    requireSameOrigin(req);
    rateLimit(req, 'register');
    const body = await readJson(req);
    if (!store.canBootstrap(body.setup)) throw new HttpError(403, 'Setup link is invalid or already used', 'bootstrap_forbidden');
    const owner = store.ensureOwner();
    const options = await generateRegistrationOptions({
      rpName: 'OpenCode Relay',
      rpID,
      userID: new Uint8Array(Buffer.from(owner.webAuthnUserID, 'base64url')),
      userName: 'owner',
      userDisplayName: owner.name,
      attestationType: 'none',
      supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      excludeCredentials: store.credentials().map((credential) => ({
        id: credential.id,
        transports: credential.transports,
      })),
    });
    const ceremony = store.createCeremony('registration', options.challenge);
    sendJson(res, 200, { ceremony, options });
  }

  async function registerVerify(req, res) {
    requireSameOrigin(req);
    rateLimit(req, 'register-verify');
    const body = await readJson(req);
    if (!store.canBootstrap(body.setup)) throw new HttpError(403, 'Setup link is invalid or already used', 'bootstrap_forbidden');
    const ceremony = store.consumeCeremony(body.ceremony, 'registration');
    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) throw new HttpError(400, 'Passkey verification failed', 'passkey_verification_failed');
    const owner = store.ensureOwner();
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    store.saveCredential({
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports,
      webauthnUserID: owner.webAuthnUserID,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
    });
    const session = store.createWebSession();
    sendJson(res, 200, { verified: true }, { 'Set-Cookie': setSessionHeader(session) });
  }

  async function authenticationOptions(req, res) {
    requireSameOrigin(req);
    rateLimit(req, 'auth');
    await readJson(req);
    if (!store.hasCredentials()) throw new HttpError(409, 'Owner passkey is not configured', 'passkey_not_configured');
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: store.credentials().map((credential) => ({
        id: credential.id,
        transports: credential.transports,
      })),
    });
    const ceremony = store.createCeremony('authentication', options.challenge);
    sendJson(res, 200, { ceremony, options });
  }

  async function authenticationVerify(req, res) {
    requireSameOrigin(req);
    rateLimit(req, 'auth-verify');
    const body = await readJson(req);
    const ceremony = store.consumeCeremony(body.ceremony, 'authentication');
    const credential = store.credentialForVerification(body.response?.id);
    if (!credential) throw new HttpError(400, 'Passkey is not registered', 'unknown_passkey');
    const verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential,
      requireUserVerification: true,
    });
    if (!verification.verified) throw new HttpError(400, 'Passkey verification failed', 'passkey_verification_failed');
    store.updateCredentialCounter(credential.id, verification.authenticationInfo.newCounter);
    const session = store.createWebSession();
    sendJson(res, 200, { verified: true }, { 'Set-Cookie': setSessionHeader(session) });
  }

  async function createPairing(req, res) {
    requireSameOrigin(req);
    requireAuthenticated(req);
    await readJson(req);
    const scope = sourceScope(getSnapshot(), pairingSourceClientID);
    const pairing = store.createPairingCode(scope);
    const mobileUrl = `${origin}/pair/mobile#code=${encodeURIComponent(pairing.code)}`;
    const qrSvg = await QRCode.toString(mobileUrl, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: { dark: '#090909ff', light: '#ffffffff' },
    });
    sendJson(res, 200, { mobileUrl, expiresAt: pairing.expiresAt, qrSvg });
  }

  async function exchangePairing(req, res) {
    rateLimit(req, 'exchange', 30);
    const body = await readJson(req);
    const issued = store.exchangePairingCode(body.code, body.deviceName);
    sendJson(res, 200, {
      connection: {
        ...issued.connection,
        url: origin,
        clientID: issued.client.clientID,
        displayNameRevision: store.deviceForClientID(issued.client.clientID)?.displayNameRevision ?? 1,
      },
    });
  }

  function requirePhone(req) {
    const client = store.authenticateBearer(bearerToken(req));
    if (!client) throw new HttpError(401, 'Phone credential is invalid or revoked', 'invalid_phone_token');
    return client;
  }

  async function phoneMe(req, res) {
    const client = requirePhone(req);
    const device = store.deviceForClientID(client.clientID);
    if (!device) throw new HttpError(401, 'Phone credential is invalid or revoked', 'invalid_phone_token');
    sendJson(res, 200, { device });
  }

  async function renamePhone(req, res) {
    rateLimit(req, 'phone-rename', 60);
    const client = requirePhone(req);
    const body = await readJson(req);
    const device = store.renameDevice(client.clientID, body.displayName);
    if (!device) throw new HttpError(404, 'Paired device was not found', 'device_not_found');
    sendJson(res, 200, { renamed: true, device });
  }

  async function renamePairing(req, res) {
    requireSameOrigin(req);
    requireAuthenticated(req);
    const body = await readJson(req);
    const device = store.renameDevice(body.clientID, body.displayName);
    if (!device) throw new HttpError(404, 'Paired device was not found', 'device_not_found');
    sendJson(res, 200, { renamed: true, device });
  }

  async function revokePairing(req, res) {
    requireSameOrigin(req);
    requireAuthenticated(req);
    const body = await readJson(req);
    if (typeof body.clientID !== 'string' || !store.revokeDevice(body.clientID)) {
      throw new HttpError(404, 'Paired device was not found', 'device_not_found');
    }
    onDeviceRevoked(body.clientID);
    sendJson(res, 200, { revoked: true });
  }

  async function createMachineDeviceCode(req, res) {
    rateLimit(req, 'machine-device-code', 12);
    const body = await readJson(req);
    const grant = store.createMachineAuthorization(body);
    const verificationUri = `${origin}/`;
    const verificationUriComplete = `${origin}/?user_code=${encodeURIComponent(grant.userCode)}`;
    sendJson(res, 200, {
      device_code: grant.deviceCode,
      user_code: grant.userCode,
      verification_uri: verificationUri,
      verification_uri_complete: verificationUriComplete,
      expires_in: Math.max(1, Math.floor((grant.expiresAt - Date.now()) / 1_000)),
      interval: Math.max(1, Math.ceil(grant.intervalMs / 1_000)),
    });
  }

  async function pollMachineToken(req, res) {
    rateLimit(req, 'machine-token', 120);
    const body = await readJson(req);
    try {
      const issued = store.pollMachineAuthorization(body.device_code);
      sendJson(res, 200, {
        token_type: 'Bearer',
        access_token: issued.accessToken,
        machine: issued.machine,
        transport: issued.transport,
        relay_origin: origin,
      });
    } catch (error) {
      if (!(error instanceof PairingStoreError)) throw error;
      sendJson(res, 400, { error: error.code, error_description: error.message });
    }
  }

  async function approveMachine(req, res) {
    requireSameOrigin(req);
    requireAuthenticated(req);
    const body = await readJson(req);
    const request = store.machineAuthorizationRequest(body.userCode);
    if (!request) throw new HttpError(404, 'Machine authorization was not found', 'authorization_not_found');
    const assignment = allocateMachineAssignment({
      request,
      snapshot: getSnapshot(),
      machines: store.listMachines(),
      transport: machineTransport,
    });
    const machine = store.approveMachineAuthorization(body.userCode, assignment);
    sendJson(res, 200, { approved: true, machine });
  }

  async function denyMachine(req, res) {
    requireSameOrigin(req);
    requireAuthenticated(req);
    const body = await readJson(req);
    if (!store.denyMachineAuthorization(body.userCode)) {
      throw new HttpError(404, 'Machine authorization was not found', 'authorization_not_found');
    }
    sendJson(res, 200, { denied: true });
  }

  function requireMachine(req) {
    const machine = store.authenticateMachine(bearerToken(req));
    if (!machine) throw new HttpError(401, 'Machine credential is invalid or revoked', 'invalid_machine_token');
    return machine;
  }

  async function machineHeartbeat(req, res) {
    rateLimit(req, 'machine-heartbeat', 180);
    const machine = requireMachine(req);
    const heartbeat = await readJson(req);
    const updated = store.updateMachineHeartbeat(machine.machineID, heartbeat);
    sendJson(res, 200, { accepted: true, machine: updated });
  }

  async function machineMe(req, res) {
    const machine = requireMachine(req);
    sendJson(res, 200, { machine });
  }

  async function renameOwnMachine(req, res) {
    rateLimit(req, 'machine-rename', 60);
    const machine = requireMachine(req);
    const body = await readJson(req);
    const renamed = store.renameMachine(machine.machineID, body.displayName);
    sendJson(res, 200, { renamed: true, machine: renamed });
  }

  async function renameMachine(req, res) {
    requireSameOrigin(req);
    requireAuthenticated(req);
    const body = await readJson(req);
    const machine = store.renameMachine(body.machineID, body.displayName);
    if (!machine) throw new HttpError(404, 'Machine was not found', 'machine_not_found');
    sendJson(res, 200, { renamed: true, machine });
  }

  async function revokeMachine(req, res) {
    requireSameOrigin(req);
    requireAuthenticated(req);
    const body = await readJson(req);
    const machine = store.listMachines().find((candidate) => candidate.machineID === body.machineID);
    if (!machine || !store.revokeMachine(body.machineID)) {
      throw new HttpError(404, 'Machine was not found or is already revoked', 'machine_not_found');
    }
    onMachineRevoked(machine);
    sendJson(res, 200, { revoked: true });
  }

  async function dashboardStatus(req, res) {
    const authenticated = isAuthenticated(req);
    const base = {
      configured: store.hasCredentials(),
      authenticated,
      devices: [],
      machines: [],
      pendingMachines: [],
    };
    if (authenticated) {
      base.devices = store.listDevices();
      base.pendingMachines = store.listPendingMachineAuthorizations();
      base.machines = await getMachineStatuses(store.listMachines());
    }
    sendJson(res, 200, base);
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', origin);
    const route = `${req.method ?? 'GET'} ${url.pathname}`;
    try {
      if (route === 'GET /' || route === 'GET /pair') {
        sendHtml(res, dashboardHtml());
        return true;
      }
      if (route === 'GET /pair/app.js') {
        sendJavaScript(res, dashboardJavaScript);
        return true;
      }
      if (route === 'GET /pair/mobile') {
        sendHtml(res, mobilePairingHtml());
        return true;
      }
      if (route === 'GET /pair/mobile.js') {
        sendJavaScript(res, mobileJavaScript);
        return true;
      }
      if (route === 'GET /api/passkey/status') {
        await dashboardStatus(req, res);
        return true;
      }
      if (route === 'POST /api/oauth/device/code') {
        await createMachineDeviceCode(req, res);
        return true;
      }
      if (route === 'POST /api/oauth/token') {
        await pollMachineToken(req, res);
        return true;
      }
      if (route === 'GET /api/machine/me') {
        await machineMe(req, res);
        return true;
      }
      if (route === 'POST /api/machine/name') {
        await renameOwnMachine(req, res);
        return true;
      }
      if (route === 'POST /api/machine/heartbeat') {
        await machineHeartbeat(req, res);
        return true;
      }
      if (route === 'POST /api/passkey/register/options') {
        await registerOptions(req, res);
        return true;
      }
      if (route === 'POST /api/passkey/register/verify') {
        await registerVerify(req, res);
        return true;
      }
      if (route === 'POST /api/passkey/auth/options') {
        await authenticationOptions(req, res);
        return true;
      }
      if (route === 'POST /api/passkey/auth/verify') {
        await authenticationVerify(req, res);
        return true;
      }
      if (route === 'POST /api/pairing/create') {
        await createPairing(req, res);
        return true;
      }
      if (route === 'OPTIONS /api/pairing/exchange') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return true;
      }
      if (route === 'POST /api/pairing/exchange') {
        await exchangePairing(req, res);
        return true;
      }
      if (route === 'GET /api/pairing/me') {
        await phoneMe(req, res);
        return true;
      }
      if (route === 'POST /api/pairing/name') {
        await renamePhone(req, res);
        return true;
      }
      if (route === 'POST /api/pairing/rename') {
        await renamePairing(req, res);
        return true;
      }
      if (route === 'POST /api/pairing/revoke') {
        await revokePairing(req, res);
        return true;
      }
      if (route === 'POST /api/machine/approve') {
        await approveMachine(req, res);
        return true;
      }
      if (route === 'POST /api/machine/deny') {
        await denyMachine(req, res);
        return true;
      }
      if (route === 'POST /api/machine/revoke') {
        await revokeMachine(req, res);
        return true;
      }
      if (route === 'POST /api/machine/rename') {
        await renameMachine(req, res);
        return true;
      }
      return false;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 400;
      const code = error instanceof HttpError ? error.code : 'request_failed';
      sendJson(res, status, { error: code, message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }

  return {
    handle,
    store,
    authenticateBearer: (token, availableTargetIDs) => store.authenticateBearer(token, availableTargetIDs),
  };
}
