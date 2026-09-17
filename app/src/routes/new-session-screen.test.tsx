import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import NewSessionScreen from '@/app/new-session';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  const state = {
    connections: [] as any[],
    relayTargets: {} as Record<string, any[]>,
    projects: {} as Record<string, any[]>,
    machineContracts: {} as Record<string, any>,
    error: null as string | null,
    createSession: vi.fn(),
    loadMachineContract: vi.fn(async () => false),
    setSessionAgent: vi.fn(),
    setSessionModel: vi.fn(),
  };
  return { push: vi.fn(), state };
});

vi.mock('expo-router', () => ({ router: { push: mocks.push } }));

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) =>
    React.forwardRef<unknown, Record<string, unknown> & { children?: React.ReactNode }>(({ children, ...props }, ref) =>
      React.createElement(name, { ...props, ref } as any, children as any),
    );
  return {
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    View: host('View'),
    StyleSheet: { create: (sheet: Record<string, unknown>) => sheet },
  };
});

vi.mock('react-native-safe-area-context', async () => {
  const React = await import('react');
  return {
    SafeAreaView: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
      React.createElement('SafeAreaView', props, children),
  };
});

vi.mock('@/src/store/mobile-store', () => ({
  // Mirrors the real helper (mobile-store.ts:116). Importing the module itself
  // pulls React Native into the graph and fails on a missing __DEV__ global.
  executionScopeKey: (ref: { connectionId: string; relayTargetID?: string }, directory?: string) =>
    JSON.stringify([ref.connectionId, ref.relayTargetID, directory ?? '']),
  useOpenCodeMobileStore: () => mocks.state,
}));

const host = (id: string, name: string) => ({
  id, name, url: `https://${id}.example.ts.net:8443`, authType: 'bearer',
  lastConnected: '2026-09-16T00:00:00.000Z', isReachable: true,
});
const target = (id: string, reachable = true) => ({
  id, name: id, reachable, lastChecked: '2026-09-16T00:00:00.000Z',
});

const contract = {
  connectionId: 'office',
  relayTargetID: 'mac',
  agents: [{ name: 'build' }, { name: 'plan' }],
  providers: [{
    id: 'anthropic',
    name: 'Anthropic',
    models: { 'claude-opus-5': { id: 'claude-opus-5', providerID: 'anthropic', name: 'Claude Opus 5' } },
  }],
  providerDefaults: { anthropic: 'claude-opus-5' },
  commands: [],
  fetchedAt: '2026-09-16T00:00:00.000Z',
};

function render() {
  let tree!: ReactTestRenderer;
  act(() => { tree = create(<NewSessionScreen />); });
  return tree;
}

const press = async (tree: ReactTestRenderer, testID: string) => {
  await act(async () => { tree.root.findByProps({ testID }).props.onPress(); });
};

beforeEach(() => {
  mocks.push.mockClear();
  mocks.state.connections = [host('office', 'Office Mac')];
  mocks.state.relayTargets = { office: [target('mac'), target('gpt'), target('down', false)] };
  mocks.state.machineContracts = {};
  mocks.state.error = null;
  mocks.state.createSession = vi.fn(async () => ({ connectionId: 'office', relayTargetID: 'mac', sessionId: 'ses_new' }));
  mocks.state.loadMachineContract = vi.fn(async () => false);
  mocks.state.setSessionAgent = vi.fn();
  mocks.state.setSessionModel = vi.fn();
});

describe('NewSessionScreen route', () => {
  it('offers the directories this machine already works in, so nothing has to be typed', async () => {
    // Typing an absolute path on a phone keyboard is the whole problem: "/~" is
    // not a path the relay accepts, and the folder a person wants is one they
    // already have sessions in.
    mocks.state.projects = {
      office: [
        { name: 'whitepaper', directory: '/Users/me/Documents/whitepaper', sessionCount: 6 },
        { name: 'home', directory: '/Users/me', sessionCount: 2 },
      ],
    };
    const tree = render();
    await press(tree, 'new-session-machine-mac');

    const choice = tree.root.findByProps({ testID: 'new-session-directory-/Users/me/Documents/whitepaper' });
    await act(async () => { choice.props.onPress(); });

    expect(tree.root.findByProps({ testID: 'new-session-directory' }).props.value)
      .toBe('/Users/me/Documents/whitepaper');
  });

  it('offers only the machines that are answering', () => {
    const tree = render();

    expect(tree.root.findAllByProps({ testID: 'new-session-machine-mac' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ testID: 'new-session-machine-gpt' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ testID: 'new-session-machine-down' })).toEqual([]);
  });

  it('creates the session on the chosen machine and opens it', async () => {
    const tree = render();
    await press(tree, 'new-session-machine-mac');
    await press(tree, 'new-session-create');

    expect(mocks.state.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'office', relayTargetID: 'mac' }),
    );
    expect(mocks.push).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/session/[sessionKey]' }),
    );
  });

  it('applies the agent and model after creation, since the create call cannot carry them', async () => {
    mocks.state.machineContracts = {
      [JSON.stringify(['office', 'mac', ''])]: contract,
    };
    const tree = render();
    await press(tree, 'new-session-machine-mac');
    await press(tree, 'new-session-agent-plan');
    await press(tree, 'new-session-create');

    const ref = { connectionId: 'office', relayTargetID: 'mac', sessionId: 'ses_new' };
    expect(mocks.state.setSessionAgent).toHaveBeenCalledWith(ref, 'plan');
    expect(mocks.state.setSessionModel).toHaveBeenCalledWith(ref, expect.objectContaining({ modelID: 'claude-opus-5' }));
  });

  it('refuses to create without a machine, and says why', async () => {
    const tree = render();
    await press(tree, 'new-session-create');

    expect(mocks.state.createSession).not.toHaveBeenCalled();
    expect(String(tree.root.findByProps({ testID: 'new-session-error' }).props.children)).toContain('Choose a machine');
  });

  it('stays put and reports when creation is refused', async () => {
    mocks.state.createSession = vi.fn(async () => null);
    mocks.state.error = 'relay said no';
    const tree = render();
    await press(tree, 'new-session-machine-mac');
    await press(tree, 'new-session-create');

    expect(mocks.push).not.toHaveBeenCalled();
    expect(String(tree.root.findByProps({ testID: 'new-session-error' }).props.children)).toContain('relay said no');
  });

  it('asks the machine what it can run when nothing is cached yet', async () => {
    // On a fresh install no session has ever cached a contract, so without this
    // the agent and model lists would stay empty forever.
    const tree = render();
    await press(tree, 'new-session-machine-mac');

    expect(mocks.state.loadMachineContract).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'office', relayTargetID: 'mac' }),
    );
  });

  it('says the machine reported nothing rather than showing an empty list', async () => {
    const tree = render();
    await press(tree, 'new-session-machine-mac');

    expect(
      String(tree.root.findByProps({ testID: 'new-session-agents-unavailable' }).props.children),
    ).toMatch(/did not report any agents|Asking this machine/);
  });
});
