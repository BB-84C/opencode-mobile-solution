import fs from 'node:fs';
import { isCanonicalAbsoluteDirectory } from './directory-path.mjs';

function emptySnapshot() {
  return { version: 2, targets: new Map(), clients: new Map() };
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function canonicalDirectory(value, label) {
  const directory = requireString(value, label);
  if (!isCanonicalAbsoluteDirectory(directory)) {
    throw new Error(`${label} must be a canonical absolute directory`);
  }
  return directory;
}

function normalizeTarget(targetID, value) {
  if (!value || typeof value !== 'object') throw new Error(`target ${targetID} must be an object`);
  const port = Number(value.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`target ${targetID} has invalid port`);
  return {
    displayName: value.displayName === undefined ? targetID : requireString(value.displayName, `target ${targetID}.displayName`),
    host: requireString(value.host, `target ${targetID}.host`),
    port,
    basicUser: requireString(value.basicUser, `target ${targetID}.basicUser`),
    basicPass: requireString(value.basicPass, `target ${targetID}.basicPass`),
  };
}

function normalizeTargetIDs(value, defaultTargetID, targets, label) {
  const targetIDs = value === undefined ? [defaultTargetID] : value;
  if (!Array.isArray(targetIDs) || targetIDs.length === 0) throw new Error(`${label} must be a non-empty array`);
  const normalized = [...new Set(targetIDs.map((targetID) => requireString(targetID, label)))];
  if (!normalized.includes(defaultTargetID)) throw new Error(`${label} must include the default targetID`);
  for (const targetID of normalized) {
    if (!targets.has(targetID)) throw new Error(`${label} references unknown target ${targetID}`);
  }
  return normalized;
}

function normalizeDirectories(value, label) {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array or null`);
  return value.map((directory) => canonicalDirectory(directory, label));
}

function normalizeV2(raw) {
  if (!raw.targets || typeof raw.targets !== 'object' || Array.isArray(raw.targets)) throw new Error('targets must be an object');
  if (!raw.clients || typeof raw.clients !== 'object' || Array.isArray(raw.clients)) throw new Error('clients must be an object');
  const targets = new Map(Object.entries(raw.targets).map(([targetID, target]) => [
    requireString(targetID, 'targetID'),
    normalizeTarget(targetID, target),
  ]));
  const clients = new Map();
  for (const [clientID, client] of Object.entries(raw.clients)) {
    if (!client || typeof client !== 'object') throw new Error(`client ${clientID} must be an object`);
    requireString(clientID, 'clientID');
    if (client.clientID !== undefined && client.clientID !== clientID) throw new Error(`client ${clientID}.clientID must match its key`);
    const targetID = requireString(client.targetID, `client ${clientID}.targetID`);
    if (!targets.has(targetID)) throw new Error(`client ${clientID} references unknown target ${targetID}`);
    const targetIDs = normalizeTargetIDs(client.targetIDs, targetID, targets, `client ${clientID}.targetIDs`);
    clients.set(clientID, {
      clientID,
      displayName: requireString(client.displayName, `client ${clientID}.displayName`),
      token: requireString(client.token, `client ${clientID}.token`),
      targetID,
      targetIDs,
      pinnedDirectory: client.pinnedDirectory === null || client.pinnedDirectory === undefined
        ? null
        : canonicalDirectory(client.pinnedDirectory, `client ${clientID}.pinnedDirectory`),
      allowedDirectories: normalizeDirectories(
        client.allowedDirectories === undefined ? [] : client.allowedDirectories,
        `client ${clientID}.allowedDirectories`,
      ),
    });
  }
  return { version: 2, targets, clients };
}

function migrateV1(raw, defaultTarget) {
  if (!raw.tokens || typeof raw.tokens !== 'object' || Array.isArray(raw.tokens)) throw new Error('legacy tokens must be an object');
  const host = requireString(defaultTarget?.host, 'defaultTarget.host');
  const port = Number(defaultTarget?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('defaultTarget.port is invalid');
  const targets = new Map();
  const clients = new Map();
  for (const [clientID, legacy] of Object.entries(raw.tokens)) {
    if (!legacy || typeof legacy !== 'object') throw new Error(`legacy client ${clientID} must be an object`);
    requireString(clientID, 'clientID');
    const targetID = `legacy:${clientID}`;
    targets.set(targetID, {
      displayName: legacy.name === undefined ? clientID : requireString(legacy.name, `legacy client ${clientID}.name`),
      host,
      port,
      basicUser: legacy.basic_user === undefined ? 'opencode' : requireString(legacy.basic_user, `legacy client ${clientID}.basic_user`),
      basicPass: requireString(legacy.basic_pass, `legacy client ${clientID}.basic_pass`),
    });
    clients.set(clientID, {
      clientID,
      displayName: legacy.name === undefined ? clientID : requireString(legacy.name, `legacy client ${clientID}.name`),
      token: requireString(legacy.token, `legacy client ${clientID}.token`),
      targetID,
      targetIDs: [targetID],
      pinnedDirectory: legacy.directory === null || legacy.directory === undefined
        ? null
        : canonicalDirectory(legacy.directory, `legacy client ${clientID}.directory`),
      // Legacy tokens never granted client-selected directories. Preserve that
      // distinction from a v2 empty allowlist, which explicitly denies one.
      allowedDirectories: undefined,
    });
  }
  return { version: 2, targets, clients };
}

export function loadConfigSnapshot({ tokensPath, defaultTarget }) {
  const raw = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config must be an object');
  return raw.version === 2 ? normalizeV2(raw) : migrateV1(raw, defaultTarget);
}

export function startConfigReloader({ tokensPath, defaultTarget, reloadSec = 60, onError = () => {}, onReload = () => {} }) {
  let snapshot;
  try {
    snapshot = loadConfigSnapshot({ tokensPath, defaultTarget });
  } catch (error) {
    snapshot = emptySnapshot();
    onError(error);
  }
  const reload = () => {
    try {
      snapshot = loadConfigSnapshot({ tokensPath, defaultTarget });
      onReload(snapshot);
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  };
  const timer = setInterval(reload, reloadSec * 1000);
  return { getSnapshot: () => snapshot, reload, close: () => clearInterval(timer) };
}
