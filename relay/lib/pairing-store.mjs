import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_WEB_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const DEFAULT_PAIRING_TTL_MS = 2 * 60 * 1_000;
const DEFAULT_CEREMONY_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MACHINE_AUTH_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_MACHINE_POLL_INTERVAL_MS = 5_000;
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function emptyState() {
  return {
    version: 2,
    owner: null,
    credentials: [],
    devices: [],
    machines: [],
  };
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function persistState(statePath, state) {
  const directory = path.dirname(statePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.${randomToken(6)}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statePath);
  fs.chmodSync(statePath, 0o600);
}

function hashToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function equalSecrets(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(candidateBytes, expectedBytes);
}

function validateState(value) {
  if (!value || typeof value !== 'object' || ![1, 2].includes(value.version)) {
    throw new Error('unsupported passkey state');
  }
  if (!Array.isArray(value.credentials) || !Array.isArray(value.devices)) {
    throw new Error('invalid passkey state');
  }
  if (value.version === 1) return { ...value, version: 2, machines: [] };
  if (!Array.isArray(value.machines)) throw new Error('invalid machine state');
  return { ...value, machines: value.machines.map(normalizeMachineIdentity) };
}

function normalizeMachineIdentity(machine) {
  if (!machine || typeof machine !== 'object') throw new Error('invalid machine state');
  const displayName = cleanText(machine.displayName, cleanText(machine.displayTargetName, 'OpenCode machine'));
  const displayNameRevision = Number.isInteger(machine.displayNameRevision) && machine.displayNameRevision > 0
    ? machine.displayNameRevision
    : 1;
  const displayNameUpdatedAt = typeof machine.displayNameUpdatedAt === 'string' && machine.displayNameUpdatedAt
    ? machine.displayNameUpdatedAt
    : machine.authorizedAt ?? machine.createdAt ?? new Date(0).toISOString();
  return {
    ...machine,
    displayName,
    displayTargetName: displayName,
    displayNameRevision,
    displayNameUpdatedAt,
  };
}

function cleanText(value, fallback, maximum = 80) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maximum);
  return normalized || fallback;
}

function cleanDeviceName(value) {
  return cleanText(value, 'OpenCode phone');
}

function cleanEditableName(value) {
  if (typeof value !== 'string') throw new Error('displayName must be a string');
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  if (!normalized) throw new Error('displayName must not be empty');
  return normalized;
}

function cleanMachineRequest(value) {
  if (!value || typeof value !== 'object') throw new Error('machine authorization request is required');
  const installationID = cleanText(value.installationID, '', 128);
  const basicUsername = cleanText(value.basicUsername, '', 80);
  const basicPassword = typeof value.basicPassword === 'string' ? value.basicPassword : '';
  const requestedTargetID = typeof value.requestedTargetID === 'string'
    ? value.requestedTargetID.trim().toLowerCase()
    : '';
  const requestedRemotePort = value.requestedRemotePort === undefined || value.requestedRemotePort === null
    ? null
    : Number(value.requestedRemotePort);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(installationID)) throw new Error('installationID is invalid');
  if (!basicUsername) throw new Error('basicUsername is required');
  if (basicPassword.length < 16 || basicPassword.length > 512) {
    throw new Error('basicPassword must contain 16 through 512 characters');
  }
  if (requestedTargetID && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(requestedTargetID)) {
    throw new Error('requestedTargetID is invalid');
  }
  if (requestedRemotePort !== null
      && (!Number.isInteger(requestedRemotePort) || requestedRemotePort < 1 || requestedRemotePort > 65_535)) {
    throw new Error('requestedRemotePort is invalid');
  }
  return {
    installationID,
    displayName: cleanText(value.displayName, 'OpenCode machine'),
    hostname: cleanText(value.hostname, 'unknown-host', 255),
    platform: cleanText(value.platform, 'unknown', 40).toLowerCase(),
    clientVersion: cleanText(value.clientVersion, 'unknown', 40),
    basicUsername,
    basicPassword,
    requestedTargetID: requestedTargetID || null,
    requestedRemotePort,
  };
}

function cloneScope(scope) {
  if (!scope || typeof scope !== 'object') throw new Error('pairing scope is required');
  if (typeof scope.targetID !== 'string' || !Array.isArray(scope.targetIDs) || scope.targetIDs.length === 0) {
    throw new Error('pairing scope must include at least one target');
  }
  return {
    targetID: scope.targetID,
    targetIDs: [...scope.targetIDs],
    pinnedDirectory: scope.pinnedDirectory ?? null,
    allowedDirectories: scope.allowedDirectories === undefined
      ? undefined
      : scope.allowedDirectories === null
        ? null
        : [...scope.allowedDirectories],
  };
}

function publicMachine(machine) {
  const {
    tokenHash: _tokenHash,
    basicUser: _basicUser,
    basicPass: _basicPass,
    ...safe
  } = machine;
  return { ...safe, heartbeat: safe.heartbeat ? { ...safe.heartbeat } : null };
}

function publicDevice(device) {
  const { tokenHash: _tokenHash, ...safe } = device;
  return { ...safe };
}

function publicAuthorization(authorization) {
  const { basicUsername: _basicUsername, basicPassword: _basicPassword, ...request } = authorization.request;
  return {
    authorizationID: authorization.authorizationID,
    userCode: authorization.userCode,
    status: authorization.status,
    createdAt: new Date(authorization.createdAt).toISOString(),
    expiresAt: new Date(authorization.expiresAt).toISOString(),
    ...request,
  };
}

function userCode() {
  let result = '';
  for (let index = 0; index < 8; index += 1) {
    result += USER_CODE_ALPHABET[crypto.randomInt(USER_CODE_ALPHABET.length)];
  }
  return `${result.slice(0, 4)}-${result.slice(4)}`;
}

export class PairingStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class PairingStore {
  constructor({
    statePath,
    bootstrapToken,
    now = Date.now,
    webSessionTtlMs = DEFAULT_WEB_SESSION_TTL_MS,
    pairingTtlMs = DEFAULT_PAIRING_TTL_MS,
    ceremonyTtlMs = DEFAULT_CEREMONY_TTL_MS,
    machineAuthorizationTtlMs = DEFAULT_MACHINE_AUTH_TTL_MS,
    machinePollIntervalMs = DEFAULT_MACHINE_POLL_INTERVAL_MS,
  }) {
    if (!statePath) throw new Error('PASSKEY_STATE_PATH is required');
    this.statePath = statePath;
    this.bootstrapToken = bootstrapToken ?? '';
    this.now = now;
    this.webSessionTtlMs = webSessionTtlMs;
    this.pairingTtlMs = pairingTtlMs;
    this.ceremonyTtlMs = ceremonyTtlMs;
    this.machineAuthorizationTtlMs = machineAuthorizationTtlMs;
    this.machinePollIntervalMs = machinePollIntervalMs;
    this.webSessions = new Map();
    this.pairingCodes = new Map();
    this.ceremonies = new Map();
    this.machineAuthorizations = new Map();
    this.machineAuthorizationsByUserCode = new Map();
    this.state = this.load();
  }

  load() {
    try {
      const stored = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      const normalized = validateState(stored);
      if (JSON.stringify(normalized) !== JSON.stringify(stored)) {
        persistState(this.statePath, normalized);
      }
      return normalized;
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState();
      throw new Error(`Unable to load passkey state: ${error.message}`);
    }
  }

  save() {
    persistState(this.statePath, this.state);
  }

  hasCredentials() {
    return this.state.credentials.length > 0;
  }

  canBootstrap(candidate) {
    return !this.hasCredentials()
      && this.bootstrapToken.length >= 24
      && equalSecrets(candidate, this.bootstrapToken);
  }

  ensureOwner() {
    if (!this.state.owner) {
      this.state.owner = {
        id: 'owner',
        name: 'OpenCode owner',
        webAuthnUserID: randomToken(32),
      };
      this.save();
    }
    return { ...this.state.owner };
  }

  credentials() {
    return this.state.credentials.map((credential) => ({ ...credential }));
  }

  saveCredential(credential) {
    if (!credential?.id || !(credential.publicKey instanceof Uint8Array)) {
      throw new Error('invalid WebAuthn credential');
    }
    const stored = {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: Number(credential.counter ?? 0),
      transports: Array.isArray(credential.transports) ? [...credential.transports] : [],
      webauthnUserID: credential.webauthnUserID,
      deviceType: credential.deviceType,
      backedUp: Boolean(credential.backedUp),
      createdAt: new Date(this.now()).toISOString(),
    };
    const existing = this.state.credentials.findIndex((item) => item.id === stored.id);
    if (existing >= 0) this.state.credentials[existing] = stored;
    else this.state.credentials.push(stored);
    this.save();
    return { ...stored };
  }

  credentialForVerification(id) {
    const credential = this.state.credentials.find((item) => item.id === id);
    if (!credential) return null;
    return {
      id: credential.id,
      publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
      counter: credential.counter,
      transports: credential.transports,
    };
  }

  updateCredentialCounter(id, counter) {
    const credential = this.state.credentials.find((item) => item.id === id);
    if (!credential) throw new Error('unknown WebAuthn credential');
    credential.counter = Number(counter);
    this.save();
  }

  createCeremony(kind, challenge) {
    this.cleanupEphemeral();
    const id = randomToken(24);
    this.ceremonies.set(id, {
      kind,
      challenge,
      expiresAt: this.now() + this.ceremonyTtlMs,
    });
    return id;
  }

  consumeCeremony(id, kind) {
    const ceremony = this.ceremonies.get(id);
    this.ceremonies.delete(id);
    if (!ceremony || ceremony.kind !== kind) throw new Error('invalid or already used passkey ceremony');
    if (ceremony.expiresAt < this.now()) throw new Error('passkey ceremony expired');
    return ceremony;
  }

  createWebSession() {
    this.cleanupEphemeral();
    const token = randomToken(32);
    this.webSessions.set(hashToken(token), this.now() + this.webSessionTtlMs);
    return token;
  }

  authenticateWebSession(token) {
    if (typeof token !== 'string' || token.length === 0) return false;
    const key = hashToken(token);
    const expiresAt = this.webSessions.get(key);
    if (!expiresAt) return false;
    if (expiresAt < this.now()) {
      this.webSessions.delete(key);
      return false;
    }
    return true;
  }

  createPairingCode(scope) {
    this.cleanupEphemeral();
    const code = randomToken(32);
    const expiresAt = this.now() + this.pairingTtlMs;
    this.pairingCodes.set(hashToken(code), {
      expiresAt,
      scope: cloneScope(scope),
    });
    return { code, expiresAt };
  }

  exchangePairingCode(code, displayName) {
    if (typeof code !== 'string' || code.length < 24) throw new Error('pairing code is invalid or already used');
    const key = hashToken(code);
    const pairing = this.pairingCodes.get(key);
    this.pairingCodes.delete(key);
    if (!pairing) throw new Error('pairing code is invalid or already used');
    if (pairing.expiresAt < this.now()) throw new Error('pairing code expired');

    const token = crypto.randomBytes(32).toString('hex');
    const clientID = `phone-${crypto.randomBytes(8).toString('hex')}`;
    const scope = cloneScope(pairing.scope);
    const nowIso = new Date(this.now()).toISOString();
    const device = {
      clientID,
      displayName: cleanDeviceName(displayName),
      displayNameRevision: 1,
      displayNameUpdatedAt: nowIso,
      tokenHash: hashToken(token),
      ...scope,
      createdAt: nowIso,
      lastUsedAt: null,
    };
    this.state.devices.push(device);
    this.save();

    return {
      connection: {
        name: device.displayName,
        authType: 'bearer',
        token,
      },
      client: this.clientFromDevice(device),
    };
  }

  authenticateBearer(token, availableTargetIDs) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const tokenHash = hashToken(token);
    const device = this.state.devices.find((item) => item.tokenHash === tokenHash);
    if (!device) return null;
    const now = this.now();
    if (!device.lastUsedAt || now - Date.parse(device.lastUsedAt) >= 5 * 60 * 1_000) {
      device.lastUsedAt = new Date(now).toISOString();
      this.save();
    }
    return this.clientFromDevice(device, availableTargetIDs);
  }

  clientFromDevice(device, availableTargetIDs) {
    const dynamicTargets = Array.isArray(availableTargetIDs)
      ? [...new Set(availableTargetIDs.filter((targetID) => typeof targetID === 'string' && targetID))]
      : null;
    // A paired device may never gain access to a target its pairing scope did not
    // grant. Intersect with the device's own grant instead of replacing it, so a
    // target that appears on the relay later cannot silently widen this device.
    const targetIDs = dynamicTargets
      ? device.targetIDs.filter((targetID) => dynamicTargets.includes(targetID))
      : [...device.targetIDs];
    const targetID = targetIDs.includes(device.targetID) ? device.targetID : targetIDs[0];
    return {
      clientID: device.clientID,
      displayName: device.displayName,
      targetID,
      targetIDs,
      pinnedDirectory: device.pinnedDirectory ?? null,
      allowedDirectories: device.allowedDirectories === undefined
        ? undefined
        : device.allowedDirectories === null
          ? null
          : [...device.allowedDirectories],
    };
  }

  listDevices() {
    return this.state.devices.map(publicDevice);
  }

  deviceForClientID(clientID) {
    const device = this.state.devices.find((item) => item.clientID === clientID);
    return device ? publicDevice(device) : null;
  }

  renameDevice(clientID, displayName) {
    const device = this.state.devices.find((item) => item.clientID === clientID);
    if (!device) return null;
    const normalized = cleanEditableName(displayName);
    if (normalized !== device.displayName) {
      device.displayName = normalized;
      device.displayNameRevision = Number(device.displayNameRevision || 0) + 1;
      device.displayNameUpdatedAt = new Date(this.now()).toISOString();
      this.save();
    }
    return publicDevice(device);
  }

  revokeDevice(clientID) {
    const previousLength = this.state.devices.length;
    this.state.devices = this.state.devices.filter((device) => device.clientID !== clientID);
    if (this.state.devices.length === previousLength) return false;
    this.save();
    return true;
  }

  createMachineAuthorization(request) {
    this.cleanupEphemeral();
    const cleaned = cleanMachineRequest(request);
    const deviceCode = randomToken(32);
    let code;
    do code = userCode(); while (this.machineAuthorizationsByUserCode.has(code));
    const createdAt = this.now();
    const authorization = {
      authorizationID: `auth-${randomToken(12)}`,
      deviceCodeHash: hashToken(deviceCode),
      userCode: code,
      status: 'pending',
      createdAt,
      expiresAt: createdAt + this.machineAuthorizationTtlMs,
      intervalMs: this.machinePollIntervalMs,
      lastPolledAt: null,
      request: cleaned,
      response: null,
    };
    this.machineAuthorizations.set(authorization.deviceCodeHash, authorization);
    this.machineAuthorizationsByUserCode.set(code, authorization);
    return {
      deviceCode,
      userCode: code,
      expiresAt: authorization.expiresAt,
      intervalMs: authorization.intervalMs,
      authorizationID: authorization.authorizationID,
    };
  }

  listPendingMachineAuthorizations() {
    this.cleanupEphemeral();
    return [...this.machineAuthorizations.values()]
      .filter((authorization) => authorization.status === 'pending')
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(publicAuthorization);
  }

  machineAuthorizationRequest(userCodeValue) {
    this.cleanupEphemeral();
    const authorization = this.machineAuthorizationsByUserCode.get(String(userCodeValue || '').toUpperCase());
    if (!authorization || authorization.status !== 'pending') return null;
    return { ...authorization.request };
  }

  approveMachineAuthorization(userCodeValue, assignment) {
    this.cleanupEphemeral();
    const code = String(userCodeValue || '').toUpperCase();
    const authorization = this.machineAuthorizationsByUserCode.get(code);
    if (!authorization || authorization.status !== 'pending') {
      throw new PairingStoreError('authorization_not_found', 'Machine authorization was not found or is no longer pending');
    }
    if (!assignment || typeof assignment.targetID !== 'string'
        || !Number.isInteger(assignment.remotePort)
        || !assignment.transport || typeof assignment.transport !== 'object') {
      throw new Error('machine assignment is invalid');
    }
    const nowIso = new Date(this.now()).toISOString();
    const accessToken = randomToken(32);
    const existingIndex = this.state.machines.findIndex(
      (machine) => machine.installationID === authorization.request.installationID,
    );
    const existing = existingIndex >= 0 ? this.state.machines[existingIndex] : null;
    const displayName = existing?.displayName ?? authorization.request.displayName;
    const machine = {
      machineID: existing?.machineID ?? `machine-${crypto.randomBytes(8).toString('hex')}`,
      installationID: authorization.request.installationID,
      displayName,
      displayNameRevision: existing?.displayNameRevision ?? 1,
      displayNameUpdatedAt: existing?.displayNameUpdatedAt ?? existing?.authorizedAt ?? nowIso,
      hostname: authorization.request.hostname,
      platform: authorization.request.platform,
      clientVersion: authorization.request.clientVersion,
      targetID: assignment.targetID,
      displayTargetName: displayName,
      host: '127.0.0.1',
      port: assignment.remotePort,
      basicUser: authorization.request.basicUsername,
      basicPass: authorization.request.basicPassword,
      tokenHash: hashToken(accessToken),
      createdAt: existing?.createdAt ?? nowIso,
      authorizedAt: nowIso,
      lastHeartbeatAt: null,
      heartbeat: null,
      revokedAt: null,
    };
    if (existingIndex >= 0) this.state.machines[existingIndex] = machine;
    else this.state.machines.push(machine);
    this.save();
    authorization.status = 'approved';
    authorization.response = {
      accessToken,
      machine: publicMachine(machine),
      transport: { ...assignment.transport, remotePort: assignment.remotePort },
    };
    return publicMachine(machine);
  }

  denyMachineAuthorization(userCodeValue) {
    this.cleanupEphemeral();
    const authorization = this.machineAuthorizationsByUserCode.get(String(userCodeValue || '').toUpperCase());
    if (!authorization || authorization.status !== 'pending') return false;
    authorization.status = 'denied';
    return true;
  }

  pollMachineAuthorization(deviceCode) {
    this.cleanupEphemeral();
    if (typeof deviceCode !== 'string' || deviceCode.length < 24) {
      throw new PairingStoreError('invalid_device_code', 'Device code is invalid');
    }
    const key = hashToken(deviceCode);
    const authorization = this.machineAuthorizations.get(key);
    if (!authorization) throw new PairingStoreError('expired_token', 'Device authorization expired or is invalid');
    const now = this.now();
    if (authorization.lastPolledAt !== null && now - authorization.lastPolledAt < authorization.intervalMs) {
      authorization.intervalMs += 1_000;
      throw new PairingStoreError('slow_down', 'Polling too quickly');
    }
    authorization.lastPolledAt = now;
    if (authorization.status === 'pending') {
      throw new PairingStoreError('authorization_pending', 'Waiting for owner approval');
    }
    if (authorization.status === 'denied') {
      this.machineAuthorizations.delete(key);
      this.machineAuthorizationsByUserCode.delete(authorization.userCode);
      throw new PairingStoreError('access_denied', 'Machine authorization was denied');
    }
    if (authorization.status !== 'approved' || !authorization.response) {
      throw new PairingStoreError('invalid_grant', 'Machine authorization cannot be completed');
    }
    const response = structuredClone(authorization.response);
    this.machineAuthorizations.delete(key);
    this.machineAuthorizationsByUserCode.delete(authorization.userCode);
    return response;
  }

  authenticateMachine(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const tokenHash = hashToken(token);
    const machine = this.state.machines.find((item) => !item.revokedAt && item.tokenHash === tokenHash);
    return machine ? publicMachine(machine) : null;
  }

  updateMachineHeartbeat(machineID, heartbeat) {
    const machine = this.state.machines.find((item) => item.machineID === machineID && !item.revokedAt);
    if (!machine) return null;
    const nowIso = new Date(this.now()).toISOString();
    const lifecycle = ['running', 'stopping', 'stopped'].includes(heartbeat?.lifecycle)
      ? heartbeat.lifecycle
      : 'running';
    machine.lastHeartbeatAt = nowIso;
    machine.heartbeat = {
      lifecycle,
      localHealth: heartbeat?.localHealth === true,
      opencodeVersion: cleanText(heartbeat?.opencodeVersion, 'unknown', 40),
      controllerVersion: cleanText(heartbeat?.controllerVersion, 'unknown', 40),
      lastError: cleanText(heartbeat?.lastError, '', 240) || null,
      reportedAt: nowIso,
    };
    this.save();
    return publicMachine(machine);
  }

  listMachines({ includeRevoked = true } = {}) {
    return this.state.machines
      .filter((machine) => includeRevoked || !machine.revokedAt)
      .map(publicMachine);
  }

  renameMachine(machineID, displayName) {
    const machine = this.state.machines.find((item) => item.machineID === machineID);
    if (!machine) return null;
    const normalized = cleanEditableName(displayName);
    if (normalized !== machine.displayName || normalized !== machine.displayTargetName) {
      machine.displayName = normalized;
      machine.displayTargetName = normalized;
      machine.displayNameRevision = Number(machine.displayNameRevision || 0) + 1;
      machine.displayNameUpdatedAt = new Date(this.now()).toISOString();
      this.save();
    }
    return publicMachine(machine);
  }

  machineTargets() {
    return this.state.machines
      .filter((machine) => !machine.revokedAt)
      .map((machine) => ({
        machineID: machine.machineID,
        targetID: machine.targetID,
        displayName: machine.displayName,
        host: machine.host,
        port: machine.port,
        basicUser: machine.basicUser,
        basicPass: machine.basicPass,
      }));
  }

  managedTargetIDs() {
    return [...new Set(this.state.machines.map((machine) => machine.targetID))];
  }

  revokeMachine(machineID) {
    const machine = this.state.machines.find((item) => item.machineID === machineID);
    if (!machine || machine.revokedAt) return false;
    machine.revokedAt = new Date(this.now()).toISOString();
    machine.tokenHash = null;
    machine.lastHeartbeatAt = null;
    machine.heartbeat = null;
    this.save();
    return true;
  }

  cleanupEphemeral() {
    const now = this.now();
    for (const [key, expiresAt] of this.webSessions) {
      if (expiresAt < now) this.webSessions.delete(key);
    }
    for (const [key, ceremony] of this.ceremonies) {
      if (ceremony.expiresAt < now) this.ceremonies.delete(key);
    }
    for (const [key, pairing] of this.pairingCodes) {
      if (pairing.expiresAt < now) this.pairingCodes.delete(key);
    }
    for (const [key, authorization] of this.machineAuthorizations) {
      if (authorization.expiresAt < now) {
        this.machineAuthorizations.delete(key);
        this.machineAuthorizationsByUserCode.delete(authorization.userCode);
      }
    }
  }
}
