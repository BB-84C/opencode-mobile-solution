import crypto from 'node:crypto';
import { isCanonicalAbsoluteDirectory } from './directory-path.mjs';

function equalTokens(candidate, expected) {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(candidateBytes, expectedBytes);
}

export function authenticateBearer(snapshot, bearerToken) {
  if (typeof bearerToken !== 'string' || bearerToken.length === 0) return null;
  for (const client of snapshot.clients.values()) {
    if (equalTokens(bearerToken, client.token)) return client;
  }
  return null;
}

export function resolveScope(client, requestedDirectory, requestedTargetID) {
  const targetID = requestedTargetID ?? client.targetID;
  if (!(client.targetIDs ?? [client.targetID]).includes(targetID)) return { ok: false, error: 'target_forbidden' };
  if (client.pinnedDirectory) return { ok: true, targetID, directory: client.pinnedDirectory };
  if (requestedDirectory === undefined) return { ok: true, targetID, directory: undefined };
  if (client.allowedDirectories === undefined) return { ok: true, targetID, directory: undefined };
  if (!isCanonicalAbsoluteDirectory(requestedDirectory)) return { ok: false, error: 'directory_forbidden' };
  if (client.allowedDirectories === null || client.allowedDirectories.includes(requestedDirectory)) {
    return { ok: true, targetID, directory: requestedDirectory };
  }
  return { ok: false, error: 'directory_forbidden' };
}
