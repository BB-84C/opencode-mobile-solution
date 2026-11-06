import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DevicesScreen from '@/app/devices';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  const state = {
    connections: [] as any[],
    relayTargets: {} as Record<string, any[]>,
    activeConnectionId: null as string | null,
    setActiveConnection: vi.fn(() => true),
    refreshActiveHost: vi.fn(async () => undefined),
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
  useOpenCodeMobileStore: () => mocks.state,
}));

const host = (id: string, name: string, isReachable = true) => ({
  id, name, url: `https://${id}.example.ts.net:8443`, authType: 'bearer',
  lastConnected: '2026-09-16T00:00:00.000Z', isReachable,
});
const machine = (id: string, reachable = true, error?: string) => ({
  id, name: id, reachable, lastChecked: '2026-09-16T00:00:00.000Z', ...(error ? { error } : {}),
});

function render() {
  let tree!: ReactTestRenderer;
  act(() => { tree = create(<DevicesScreen />); });
  return tree;
}

const textOf = (tree: ReactTestRenderer) =>
  tree.root.findAllByType('Text' as any).flatMap((node) => node.children).filter((child) => typeof child === 'string').join(' | ');

beforeEach(() => {
  mocks.push.mockClear();
  mocks.state.setActiveConnection.mockClear();
  mocks.state.refreshActiveHost.mockClear();
  mocks.state.connections = [];
  mocks.state.relayTargets = {};
  mocks.state.activeConnectionId = null;
});

describe('DevicesScreen route', () => {
  it('always offers a way to manage hosts, even when every host is unreachable', () => {
    // Without this the screen is a dead end: it lives outside the tabs, so an
    // unreachable host leaves no way to add, edit or remove one.
    mocks.state.connections = [host('office', 'Office Mac', false)];
    mocks.state.relayTargets = {};

    const text = textOf(render());

    expect(text).toContain('Manage hosts');
  });

  it('asks the relay for its machines when nothing is cached yet', async () => {
    // The screen only reads the list. On a cold start nothing has fetched it, so
    // without this it reports "no machine authorized" for a healthy relay.
    mocks.state.connections = [host('office', 'Office Mac')];
    mocks.state.relayTargets = {};

    await act(async () => { create(<DevicesScreen />); });

    expect(mocks.state.setActiveConnection).toHaveBeenCalledWith('office');
    expect(mocks.state.refreshActiveHost).toHaveBeenCalled();
  });

  it('does not re-ask once the machines are known', async () => {
    mocks.state.connections = [host('office', 'Office Mac')];
    mocks.state.relayTargets = { office: [machine('default')] };

    await act(async () => { create(<DevicesScreen />); });

    expect(mocks.state.refreshActiveHost).not.toHaveBeenCalled();
  });

  it('lists every machine under the host it belongs to', () => {
    mocks.state.connections = [host('office', 'Office Mac'), host('spare', 'Spare')];
    mocks.state.relayTargets = { office: [machine('default'), machine('gpt')], spare: [machine('local')] };

    const text = textOf(render());

    expect(text).toContain('Office Mac');
    expect(text).toContain('default');
    expect(text).toContain('gpt');
    expect(text).toContain('Spare');
    expect(text).toContain('local');
  });

  it('warns about the shared session database only where it applies', () => {
    mocks.state.connections = [host('office', 'Office Mac')];
    mocks.state.relayTargets = { office: [machine('default'), machine('gpt')] };
    expect(textOf(render())).toContain('share one session database');

    mocks.state.relayTargets = { office: [machine('default')] };
    // With one machine there is nothing to confuse, so the caveat would be noise.
    expect(textOf(render())).not.toContain('share one session database');
  });

  it('opens a reachable machine by activating its host and passing the machine along', () => {
    mocks.state.connections = [host('office', 'Office Mac')];
    mocks.state.relayTargets = { office: [machine('default'), machine('gpt')] };
    const tree = render();

    const buttons = tree.root.findAllByType('Pressable' as any);
    act(() => { buttons[1].props.onPress(); });

    expect(mocks.state.setActiveConnection).toHaveBeenCalledWith('office');
    expect(mocks.push).toHaveBeenCalledWith({ pathname: '/two', params: { machine: 'gpt' } });
  });

  it('refuses a machine that is not answering, and says why', () => {
    mocks.state.connections = [host('office', 'Office Mac')];
    mocks.state.relayTargets = { office: [machine('default', false, 'upstream refused the connection')] };
    const tree = render();

    expect(textOf(tree)).toContain('upstream refused the connection');
    const blocked = tree.root.findAllByType('Pressable' as any)[0];
    expect(blocked.props.disabled).toBe(true);
    act(() => { blocked.props.onPress(); });
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('opens straight through when there is only one machine to choose', () => {
    // Otherwise this screen is a dialog the user dismisses on every launch.
    mocks.state.connections = [host('office', 'Office Mac')];
    mocks.state.relayTargets = { office: [machine('default')] };

    render();

    expect(mocks.state.setActiveConnection).toHaveBeenCalledWith('office');
    expect(mocks.push).toHaveBeenCalledWith({ pathname: '/two', params: { machine: 'default' } });
  });

  it('does not open by itself when there is a real choice', () => {
    mocks.state.connections = [host('office', 'Office Mac')];
    mocks.state.relayTargets = { office: [machine('default'), machine('gpt')] };

    render();

    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('explains an empty screen instead of showing nothing', () => {
    const text = textOf(render());

    expect(text).toContain('No host is paired yet');
    expect(text).toContain('Pair a host');
  });
});
