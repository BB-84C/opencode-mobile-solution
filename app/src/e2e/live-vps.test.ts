import { describe, expect, it } from 'vitest';

import { OpenCodeClient } from '@/src/opencode/client';
import { resolvePromptSelection } from '@/src/opencode/execution-contract';
import type { HostConnection, MessagePart, Session } from '@/src/opencode/types';
import { filterAndSortRootSessions } from '@/src/ux/session-list';

const LIVE_URL = process.env.OPENCODE_E2E_URL;
const LIVE_TOKEN = process.env.OPENCODE_E2E_TOKEN;
const LIVE_CONFIGURED = Boolean(LIVE_URL && LIVE_TOKEN);
const LIVE_REQUIRED = process.env.OPENCODE_E2E_REQUIRED === '1' || process.env.npm_lifecycle_event === 'e2e:vps';
const SEND_PROBE = process.env.OPENCODE_E2E_SEND === '1';
const TEST_SESSION_TITLE = 'iOS App Test Session';

describe.runIf(LIVE_CONFIGURED)('live VPS monitor/control flow', () => {
  const connection: HostConnection = {
    id: 'live-relay',
    name: 'Live relay',
    url: LIVE_URL!,
    authType: 'bearer',
    token: LIVE_TOKEN!,
    lastConnected: null,
    isReachable: true,
  };

  it('discovers every relay machine without creating a session', async () => {
    const relay = new OpenCodeClient(connection);
    const targets = await relay.listRelayTargets();
    expect(targets.length).toBeGreaterThan(0);

    const discovered = await Promise.all(targets.map(async (target) => ({
      target,
      sessions: await new OpenCodeClient(connection, { relayTargetID: target.id }).listSessions(),
    })));
    expect(discovered.some((machine) => machine.sessions.length > 0)).toBe(true);
    for (const machine of discovered) {
      const roots = filterAndSortRootSessions(machine.sessions);
      expect(roots.every((session) => !session.parentID)).toBe(true);
      expect(isNewestFirst(roots)).toBe(true);
    }
  }, 60_000);

  it('loads the exact test session contract from its own machine and directory', async () => {
    const match = await findOnlyTestSession(connection);
    const directory = match.session.location?.directory ?? match.session.directory ?? match.session.path;
    const client = new OpenCodeClient(connection, { relayTargetID: match.targetID });
    const [messages, agents, configuredProviders, config] = await Promise.all([
      client.listMessages(match.session.id),
      client.listAgents({ directory }),
      client.listConfiguredProviders({ directory }),
      client.getConfig({ directory }),
    ]);
    const resolved = resolvePromptSelection({
      contract: {
        agents,
        configuredProviders,
        configModel: typeof config.model === 'string' ? config.model : undefined,
      },
      messages,
      session: match.session,
    });
    expect(resolved?.agentName).toBeTruthy();
    expect(resolved?.model.providerID).toBeTruthy();
    expect(resolved?.model.modelID).toBeTruthy();
  }, 60_000);

  it.runIf(SEND_PROBE)('round trips one message only through the designated test session', async () => {
    const match = await findOnlyTestSession(connection);
    const directory = match.session.location?.directory ?? match.session.directory ?? match.session.path;
    const client = new OpenCodeClient(connection, { relayTargetID: match.targetID });
    const [before, agents, configuredProviders, config] = await Promise.all([
      client.listMessages(match.session.id),
      client.listAgents({ directory }),
      client.listConfiguredProviders({ directory }),
      client.getConfig({ directory }),
    ]);
    const selection = resolvePromptSelection({
      contract: {
        agents,
        configuredProviders,
        configModel: typeof config.model === 'string' ? config.model : undefined,
      },
      messages: before,
      session: match.session,
    });
    if (!selection) throw new Error('The target machine did not provide a valid agent/model contract');

    const marker = `IOS_SIMULATOR_E2E_${Date.now()}`;
    await client.sendAsync(
      match.session.id,
      [{ type: 'text', text: `Reply with exactly ${marker}` }],
      {
        agent: selection.agentName,
        model: selection.model,
        variant: selection.variant,
        directory,
      },
    );
    const after = await waitForMessage(client, match.session.id, marker);
    expect(after.some((message) => message.parts.some((part) => partText(part).includes(marker)))).toBe(true);
  }, 180_000);
});

describe.runIf(LIVE_REQUIRED && !LIVE_CONFIGURED)('live VPS monitor/control flow', () => {
  it('requires the relay connection environment', () => {
    throw new Error('Missing OPENCODE_E2E_URL or OPENCODE_E2E_TOKEN. Load the local connection card before running npm run e2e:vps.');
  });
});

async function findOnlyTestSession(connection: HostConnection) {
  const relay = new OpenCodeClient(connection);
  const targets = await relay.listRelayTargets();
  const matches: Array<{ targetID: string; session: Session }> = [];
  for (const target of targets) {
    const sessions = await new OpenCodeClient(connection, { relayTargetID: target.id }).listSessions();
    for (const session of sessions) {
      if (session.title === TEST_SESSION_TITLE) {
        matches.push({ targetID: target.id, session });
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${TEST_SESSION_TITLE}, found ${matches.length}`);
  }
  return matches[0];
}

async function waitForMessage(client: OpenCodeClient, sessionId: string, marker: string) {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const messages = await client.listMessages(sessionId);
    if (messages.some((message) => message.parts.some((part) => partText(part).includes(marker)))) return messages;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`Timed out waiting for ${marker}`);
}

function partText(part: MessagePart) {
  if ('text' in part && typeof part.text === 'string') return part.text;
  return '';
}

function isNewestFirst(sessions: Session[]) {
  const updated = (session: Session) => (session.time?.updated ?? Date.parse(session.updated ?? '')) || 0;
  return sessions.every((session, index) => index === 0 || updated(sessions[index - 1]) >= updated(session));
}
