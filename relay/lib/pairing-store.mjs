import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_WEB_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const DEFAULT_PAIRING_TTL_MS = 2 * 60 * 1_000;
const DEFAULT_CEREMONY_TTL_MS = 5 * 60 * 1_000;

function emptyState() {
  return {
    version: 3,
    owner: null,
    credentials: [],
    devices: [],
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
  if (!value || typeof value !== 'object' || ![1, 2, 3].includes(value.version)) {
    throw new Error('unsupported passkey state');
  }
  if (!Array.isArray(value.credentials) || !Array.isArray(value.devices)) {
    throw new Error('invalid passkey state');
  }
  // Versions 1 and 2 predate the removal of machine enrolment. A state file
  // written by the tunnel-era relay carries a `machines` array that nothing
  // reads any more; drop it rather than reject the file, so an existing
  // deployment keeps its owner credential and its paired devices on upgrade.
  const { machines, ...rest } = value;
  return { ...rest, version: 3 };
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

function publicDevice(device) {
  const { tokenHash: _tokenHash, ...safe } = device;
  return { ...safe };
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
  }) {
    if (!statePath) throw new Error('PASSKEY_STATE_PATH is required');
    this.statePath = statePath;
    this.bootstrapToken = bootstrapToken ?? '';
    this.now = now;
    this.webSessionTtlMs = webSessionTtlMs;
    this.pairingTtlMs = pairingTtlMs;
    this.ceremonyTtlMs = ceremonyTtlMs;
    this.webSessions = new Map();
    this.pairingCodes = new Map();
    this.ceremonies = new Map();
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
  }
}
