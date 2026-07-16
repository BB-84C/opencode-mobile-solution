import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SessionsScreen from '@/app/(tabs)/two';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  state: {
    activeConnectionId: 'relay',
    hydrated: true,
    connections: [{ id: 'relay', name: 'Example Relay', url: 'https://opencode.example.com', authType: 'bearer', token: 'x', lastConnected: null, isReachable: true }],
    sessions: {
      relay: [
        { id: 'mac-new', title: 'Newest Mac', directory: '/mac/new', relayTargetID: 'mac', relayTargetName: 'MacBook', time: { updated: 300 } },
        { id: 'win', title: 'Windows build', directory: 'D:/repo', relayTargetID: 'windows', relayTargetName: 'Server', time: { updated: 200 } },
        { id: 'mac-old', title: 'Old Mac', directory: '/mac/old', relayTargetID: 'mac', relayTargetName: 'MacBook', time: { updated: 100 } },
        { id: 'child', title: 'Child hidden at root', directory: '/mac/new', parentID: 'mac-new', relayTargetID: 'mac', relayTargetName: 'MacBook', time: { updated: 400 } },
        { id: 'orphan-child', title: 'Orphan child must stay hidden', directory: '/mac/new', parentID: 'missing-parent', relayTargetID: 'mac', relayTargetName: 'MacBook', time: { updated: 500 } },
      ],
    },
    sessionStatuses: {},
    loading: 'idle',
    error: null,
    hostSyncErrors: {} as Record<string, string | null>,
    clearActiveConnection: vi.fn(),
    refreshActiveHost: vi.fn(async () => undefined),
    subscribeToActiveHost: vi.fn(),
    unsubscribeFromHost: vi.fn(),
  },
}));

vi.mock('expo-router', async () => {
  const React = await import('react');
  return {
    router: { push: mocks.push },
    useFocusEffect: (callback: () => void | (() => void)) => React.useEffect(callback, [callback]),
  };
});

vi.mock('expo-symbols', async () => {
  const React = await import('react');
  return { SymbolView: (props: any) => React.createElement('SymbolView', props) };
});

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) => React.forwardRef(({ children, ...props }: any, ref) => React.createElement(name, { ...props, ref }, children));
  const FlatList = ({ data = [], renderItem, ListHeaderComponent, ListEmptyComponent, keyExtractor, ...props }: any) => React.createElement(
    'FlatList',
    props,
    ListHeaderComponent,
    data.length
      ? data.map((item: any, index: number) => React.createElement(React.Fragment, { key: keyExtractor(item, index) }, renderItem({ item, index })))
      : ListEmptyComponent,
  );
  return {
    ActivityIndicator: host('ActivityIndicator'),
    FlatList,
    Keyboard: { dismiss: vi.fn() },
    Pressable: host('Pressable'),
    StyleSheet: { create: (styles: any) => styles },
    Text: host('Text'),
    TextInput: host('TextInput'),
    View: host('View'),
  };
});

vi.mock('react-native-safe-area-context', async () => {
  const React = await import('react');
  return { SafeAreaView: ({ children, ...props }: any) => React.createElement('SafeAreaView', props, children) };
});

vi.mock('@/src/store/mobile-store', () => ({
  useOpenCodeMobileStore: (selector?: (state: typeof mocks.state) => unknown) => selector ? selector(mocks.state) : mocks.state,
}));

describe('SessionsScreen', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    mocks.push.mockReset();
    mocks.state.activeConnectionId = 'relay';
    mocks.state.loading = 'idle';
    mocks.state.error = null;
    mocks.state.hostSyncErrors = {};
    mocks.state.clearActiveConnection.mockReset();
    mocks.state.refreshActiveHost.mockReset();
    mocks.state.refreshActiveHost.mockResolvedValue(undefined);
    mocks.state.subscribeToActiveHost.mockReset();
    mocks.state.unsubscribeFromHost.mockReset();
  });

  it('is a monitor-only existing-session list with no workbench prompt or create entry', async () => {
    const screen = await renderScreen();
    expect(all(screen, 'workbench-prompt-input')).toHaveLength(0);
    expect(all(screen, 'new-session')).toHaveLength(0);
    expect(text(screen)).toContain('3 existing sessions');
    expect(text(screen)).not.toContain('Child hidden at root');
    expect(text(screen)).not.toContain('Orphan child must stay hidden');
  });

  it('renders root sessions newest first and filters locally across machines', async () => {
    const screen = await renderScreen();
    const titles = screen.root.findAll((node) => String(node.type) === 'Pressable' && String(node.props?.testID ?? '').startsWith('session-card-'))
      .map((node) => String(node.props.accessibilityLabel).replace(/^Open /, ''));
    expect(titles).toEqual(['Newest Mac', 'Windows build', 'Old Mac']);

    await act(async () => find(screen, 'sessions-search-input').props.onChangeText('Server'));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 175)));
    expect(text(screen)).toContain('Windows build');
    expect(text(screen)).not.toContain('Newest Mac');
    expect(text(screen)).toContain('1 existing session');
  });

  it('deduplicates ten rapid taps synchronously and blocks the list during transition', async () => {
    const screen = await renderScreen();
    const card = screen.root.findAll((node) => String(node.props?.testID ?? '').startsWith('session-card-'))[0];
    await act(async () => {
      for (let index = 0; index < 10; index += 1) card.props.onPress();
    });
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(find(screen, 'session-navigation-blocker')).toBeTruthy();
  });

  it('shows a visible initial loading state instead of a silent empty page', async () => {
    mocks.state.loading = 'loading';
    const original = mocks.state.sessions.relay;
    mocks.state.sessions.relay = [];
    const screen = await renderScreen();
    expect(find(screen, 'sessions-loading')).toBeTruthy();
    mocks.state.sessions.relay = original;
  });

  it('surfaces a refresh failure while preserving cached sessions', async () => {
    mocks.state.hostSyncErrors = { relay: 'Windows target timed out' };
    const screen = await renderScreen();
    expect(find(screen, 'sessions-load-error')).toBeTruthy();
    expect(text(screen)).toContain('Sync warning · Windows target timed out');
    expect(text(screen)).toContain('Newest Mac');
  });

  it('clears a stale active relay only from an effect', async () => {
    mocks.state.activeConnectionId = 'missing';
    const screen = await renderScreen();
    expect(text(screen)).toContain('No relay selected');
    expect(mocks.state.clearActiveConnection).toHaveBeenCalledOnce();
  });
});

async function renderScreen() {
  let screen!: ReactTestRenderer;
  await act(async () => { screen = create(<SessionsScreen />); });
  return screen;
}

function find(screen: ReactTestRenderer, testID: string) {
  return screen.root.findByProps({ testID });
}

function all(screen: ReactTestRenderer, testID: string) {
  return screen.root.findAllByProps({ testID });
}

function text(screen: ReactTestRenderer) {
  return screen.root.findAllByType('Text' as any).map((node) => flatten(node.props.children)).join(' ');
}

function flatten(value: unknown): string {
  if (Array.isArray(value)) return value.map(flatten).join('');
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
