import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SettingsScreen from '@/app/modal';
import { settingsModalOptions } from '@/src/ux/settings-navigation';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  back: vi.fn(),
  replace: vi.fn(),
  state: {
    activeConnectionId: 'host-live' as string | null,
    connections: [
      {
        id: 'host-live',
        name: 'Live VPS',
        url: 'https://opencode.example.test',
        isReachable: true,
      },
    ],
    loading: 'idle',
    error: null as string | null,
    hydrate: vi.fn(),
    refreshActiveHost: vi.fn(),
    clearActiveConnection: vi.fn(),
  },
}));

vi.mock('expo-router', () => ({
  router: { back: mocks.back, replace: mocks.replace },
}));

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) =>
    React.forwardRef<unknown, Record<string, unknown> & { children?: React.ReactNode }>(({ children, ...props }, ref) =>
      React.createElement(name, { ...props, ref } as any, children as any),
    );
  return {
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
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

describe('SettingsScreen route', () => {
  beforeEach(() => {
    mocks.back.mockReset();
    mocks.replace.mockReset();
    mocks.state.hydrate.mockReset();
    mocks.state.refreshActiveHost.mockReset();
    mocks.state.clearActiveConnection.mockReset();
    mocks.state.activeConnectionId = 'host-live';
    mocks.state.loading = 'idle';
    mocks.state.error = null;
  });

  it('replaces the Expo template modal with working host, sync, and clear actions', async () => {
    const screen = renderScreen();

    expect(mocks.state.hydrate).toHaveBeenCalledTimes(1);
    expect(textContents(screen)).toContain('Live VPS');
    expect(textContents(screen)).toContain('OpenCode dark');

    await act(async () => screen.root.findByProps({ testID: 'settings-sync-host' }).props.onPress());
    expect(mocks.state.refreshActiveHost).toHaveBeenCalledTimes(1);

    await act(async () => screen.root.findByProps({ testID: 'settings-manage-hosts' }).props.onPress());
    expect(mocks.replace).toHaveBeenCalledWith('/');

    await act(async () => screen.root.findByProps({ testID: 'settings-clear-active-host' }).props.onPress());
    expect(mocks.state.clearActiveConnection).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledWith('/');

    expect(screen.root.findByProps({ testID: 'settings-safe-area' }).props.edges).toEqual(['bottom', 'left', 'right']);
    expect(screen.root.findAllByProps({ testID: 'settings-close' })).toHaveLength(0);
  });

  it('places Done in the native navigation header instead of beneath the status bar', async () => {
    expect(settingsModalOptions.headerShown).toBe(true);
    expect(settingsModalOptions.presentation).toBe('fullScreenModal');

    let header: ReactTestRenderer | undefined;
    act(() => {
      header = create(settingsModalOptions.headerRight());
    });
    await act(async () => header!.root.findByProps({ testID: 'settings-close' }).props.onPress());
    expect(mocks.back).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed settings sync visible and retryable', async () => {
    mocks.state.refreshActiveHost.mockRejectedValueOnce(new Error('Sync unavailable'));
    const screen = renderScreen();

    await act(async () => screen.root.findByProps({ testID: 'settings-sync-host' }).props.onPress());

    expect(screen.root.findByProps({ testID: 'settings-action-error' }).props.children).toBe('Sync unavailable');
    expect(screen.root.findByProps({ testID: 'settings-sync-host' }).props.disabled).toBe(false);
  });
});

function renderScreen() {
  let screen: ReactTestRenderer | undefined;
  act(() => {
    screen = create(<SettingsScreen />);
  });
  return screen!;
}

function textContents(screen: ReactTestRenderer) {
  return screen.root
    .findAllByType('Text' as any)
    .map((node) => node.props.children)
    .flat(Number.POSITIVE_INFINITY)
    .filter((value) => typeof value === 'string');
}
