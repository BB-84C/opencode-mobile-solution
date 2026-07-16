import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import HostsScreen from '@/app/(tabs)/index';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  const state = {
    connections: [
      {
        id: 'host-live',
        name: 'Live VPS',
        url: 'https://opencode.example.test',
        authType: 'bearer',
        token: 'redacted',
        lastConnected: null,
        isReachable: true,
      },
    ],
    activeConnectionId: null,
    loading: 'idle',
    error: null,
    hydrate: vi.fn(),
    addConnection: vi.fn(),
    updateConnection: vi.fn(),
    removeConnection: vi.fn(),
    setActiveConnection: vi.fn(),
    clearActiveConnection: vi.fn(),
    refreshActiveHost: vi.fn(),
  };
  return {
    dismissKeyboard: vi.fn(),
    dismissScanner: vi.fn(),
    launchScanner: vi.fn(),
    qrListener: undefined as undefined | ((event: { data: string }) => void),
    removeQrListener: vi.fn(),
    requestCameraPermission: vi.fn(),
    push: vi.fn(),
    state,
  };
});

vi.mock('expo-router', () => ({
  router: {
    push: mocks.push,
  },
}));

vi.mock('expo-symbols', async () => {
  const React = await import('react');
  return { SymbolView: (props: Record<string, unknown>) => React.createElement('SymbolView', props) };
});

vi.mock('expo-camera', () => ({
  Camera: {
    requestCameraPermissionsAsync: mocks.requestCameraPermission,
  },
  CameraView: {
    isModernBarcodeScannerAvailable: true,
    launchScanner: mocks.launchScanner,
    dismissScanner: mocks.dismissScanner,
    onModernBarcodeScanned: (listener: (event: { data: string }) => void) => {
      mocks.qrListener = listener;
      return { remove: mocks.removeQrListener };
    },
  },
}));

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) =>
    React.forwardRef<unknown, Record<string, unknown> & { children?: React.ReactNode }>(({ children, ...props }, ref) =>
      React.createElement(name, { ...props, ref } as any, children as any),
    );

  return {
    Keyboard: { dismiss: mocks.dismissKeyboard },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: {
      create: <T extends Record<string, unknown>>(styles: T) => styles,
      flatten: (style: unknown) => style,
      hairlineWidth: 1,
    },
    Text: host('Text'),
    TextInput: host('TextInput'),
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

describe('HostsScreen route', () => {
  beforeEach(() => {
    mocks.dismissKeyboard.mockReset();
    mocks.dismissScanner.mockReset();
    mocks.dismissScanner.mockResolvedValue(undefined);
    mocks.launchScanner.mockReset();
    mocks.launchScanner.mockResolvedValue(undefined);
    mocks.qrListener = undefined;
    mocks.removeQrListener.mockReset();
    mocks.requestCameraPermission.mockReset();
    mocks.requestCameraPermission.mockResolvedValue({ granted: true });
    mocks.push.mockReset();
    mocks.state.hydrate.mockReset();
    mocks.state.addConnection.mockReset();
    mocks.state.updateConnection.mockReset();
    mocks.state.removeConnection.mockReset();
    mocks.state.setActiveConnection.mockReset();
    mocks.state.setActiveConnection.mockReturnValue(true);
    mocks.state.clearActiveConnection.mockReset();
    mocks.state.refreshActiveHost.mockReset();
    mocks.state.activeConnectionId = null;
    mocks.state.loading = 'idle';
    mocks.state.error = null;
    mocks.state.connections = [
      {
        id: 'host-live',
        name: 'Live VPS',
        url: 'https://opencode.example.test',
        authType: 'bearer',
        token: 'redacted',
        lastConnected: null,
        isReachable: true,
      },
    ];
  });

  it('hydrates saved hosts without navigating into the workbench', () => {
    renderScreen();

    expect(mocks.state.hydrate).toHaveBeenCalledTimes(1);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('opens real app settings from the Hosts header', async () => {
    const screen = renderScreen();
    await act(async () => screen.root.findByProps({ testID: 'hosts-settings-button' }).props.onPress());
    expect(mocks.push).toHaveBeenCalledWith('/modal');
  });

  it('keeps long host identity rows readable and adjusts the form for the keyboard', () => {
    mocks.state.connections = [
      {
        ...mocks.state.connections[0],
        name: 'A very long workstation name that must not cover status',
      },
    ];
    const screen = renderScreen();

    expect(screen.root.findByProps({ testID: 'hosts-scroll' }).props.automaticallyAdjustKeyboardInsets).toBe(true);
    expect(screen.root.findByProps({ testID: 'hosts-scroll' }).props.keyboardDismissMode).toBe('interactive');
    expect(screen.root.findByProps({ testID: 'hosts-scroll' }).props.keyboardShouldPersistTaps).toBe('handled');
    expect(screen.root.findByProps({ testID: 'hosts-safe-area' }).props.edges).toEqual(['top', 'left', 'right']);
    expect(screen.root.findByProps({ testID: 'host-name-host-live' }).props.numberOfLines).toBe(2);
    expect(
      [screen.root.findByProps({ testID: 'host-status-host-live' }).props.style]
        .flat(Number.POSITIVE_INFINITY),
    ).toContainEqual(expect.objectContaining({ flexShrink: 0 }));
  });

  it('selects an explicit host before routing to the workbench', () => {
    const screen = renderScreen();

    act(() => {
      screen.root.findByProps({ testID: 'host-card-host-live' }).props.onPress();
    });

    expect(mocks.state.setActiveConnection).toHaveBeenCalledWith('host-live');
    expect(mocks.push).toHaveBeenCalledWith('/two');
    expect(mocks.state.addConnection).not.toHaveBeenCalled();
  });

  it('does not route into the workbench when active host selection is rejected', () => {
    mocks.state.setActiveConnection.mockReturnValue(false);
    const screen = renderScreen();

    act(() => {
      screen.root.findByProps({ testID: 'host-card-host-live' }).props.onPress();
    });

    expect(mocks.state.setActiveConnection).toHaveBeenCalledWith('host-live');
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.state.addConnection).not.toHaveBeenCalled();
  });

  it('adds a host without selecting it or entering the workbench', async () => {
    mocks.state.addConnection.mockResolvedValue(undefined);
    const screen = renderScreen();
    await openAdvancedSetup(screen);
    const inputs = screen.root.findAllByType('TextInput' as any);

    await act(async () => {
      inputs[0].props.onChangeText('Bench VPS');
      inputs[1].props.onChangeText('https://bench.example.test/');
      inputs[2].props.onChangeText('token-value');
    });
    await act(async () => {
      await screen.root.findByProps({ testID: 'add-host-button' }).props.onPress();
    });

    expect(mocks.state.addConnection).toHaveBeenCalledWith({
      name: 'Bench VPS',
      url: 'https://bench.example.test/',
      authType: 'bearer',
      token: 'token-value',
    });
    expect(mocks.state.setActiveConnection).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('adds a basic-auth host without selecting it or entering the workbench', async () => {
    mocks.state.addConnection.mockResolvedValue(undefined);
    const screen = renderScreen();
    await openAdvancedSetup(screen);
    let inputs = screen.root.findAllByType('TextInput' as any);

    await act(async () => {
      inputs[0].props.onChangeText('Bench Basic');
      inputs[1].props.onChangeText('https://bench-basic.example.test/');
    });
    await act(async () => {
      screen.root.findByProps({ testID: 'auth-mode-basic' }).props.onPress();
    });
    inputs = screen.root.findAllByType('TextInput' as any);
    await act(async () => {
      inputs[2].props.onChangeText('opencode-user');
      inputs[3].props.onChangeText('basic-secret');
    });
    await act(async () => {
      await screen.root.findByProps({ testID: 'add-host-button' }).props.onPress();
    });

    expect(mocks.state.addConnection).toHaveBeenCalledWith({
      name: 'Bench Basic',
      url: 'https://bench-basic.example.test/',
      authType: 'basic',
      username: 'opencode-user',
      password: 'basic-secret',
    });
    expect(mocks.state.setActiveConnection).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('keeps invalid host URLs and hostless health checks non-actionable with inline guidance', async () => {
    const screen = renderScreen();
    await openAdvancedSetup(screen);

    expect(screen.root.findByProps({ testID: 'check-active-host-button' }).props.disabled).toBe(true);
    await act(async () => {
      screen.root.findByProps({ testID: 'host-url-input' }).props.onChangeText('not a relay URL');
      screen.root.findByProps({ testID: 'host-token-input' }).props.onChangeText('token-value');
    });

    expect(screen.root.findByProps({ testID: 'host-url-error' }).props.children).toContain('http');
    expect(screen.root.findByProps({ testID: 'add-host-button' }).props.disabled).toBe(true);
    expect(mocks.state.addConnection).not.toHaveBeenCalled();
    expect(mocks.state.refreshActiveHost).not.toHaveBeenCalled();
  });

  it('preserves credentials and reports an add-host failure inline', async () => {
    mocks.state.addConnection.mockRejectedValueOnce(new Error('Relay could not be saved'));
    const screen = renderScreen();
    await openAdvancedSetup(screen);

    await act(async () => {
      screen.root.findByProps({ testID: 'host-name-input' }).props.onChangeText('Bench VPS');
      screen.root.findByProps({ testID: 'host-url-input' }).props.onChangeText('https://bench.example.test');
      screen.root.findByProps({ testID: 'host-token-input' }).props.onChangeText('token-value');
    });
    await act(async () => {
      await screen.root.findByProps({ testID: 'add-host-button' }).props.onPress();
    });

    expect(screen.root.findByProps({ testID: 'hosts-action-error' }).props.children).toBe('Relay could not be saved');
    expect(screen.root.findByProps({ testID: 'host-url-input' }).props.value).toBe('https://bench.example.test');
    expect(screen.root.findByProps({ testID: 'host-token-input' }).props.value).toBe('token-value');
  });

  it('edits a saved host in place and supports canceling the editor', async () => {
    mocks.state.updateConnection.mockResolvedValue(undefined);
    const screen = renderScreen();

    await act(async () => screen.root.findByProps({ testID: 'edit-host-host-live' }).props.onPress());
    expect(screen.root.findByProps({ testID: 'host-name-input' }).props.value).toBe('Live VPS');
    expect(screen.root.findByProps({ testID: 'host-url-input' }).props.value).toBe('https://opencode.example.test');
    expect(screen.root.findByProps({ testID: 'host-token-input' }).props.value).toBe('redacted');

    await act(async () => screen.root.findByProps({ testID: 'host-name-input' }).props.onChangeText('Updated host'));
    await act(async () => screen.root.findByProps({ testID: 'add-host-button' }).props.onPress());

    expect(mocks.state.updateConnection).toHaveBeenCalledWith('host-live', {
      name: 'Updated host',
      url: 'https://opencode.example.test',
      authType: 'bearer',
      token: 'redacted',
    });
    expect(mocks.state.addConnection).not.toHaveBeenCalled();
  });

  it('requires an explicit second tap before deleting a saved host', async () => {
    mocks.state.removeConnection.mockResolvedValue(undefined);
    const screen = renderScreen();
    const deleteButton = () => screen.root.findByProps({ testID: 'delete-host-host-live' });

    await act(async () => deleteButton().props.onPress());
    expect(mocks.state.removeConnection).not.toHaveBeenCalled();
    expect(deleteButton().props.accessibilityLabel).toContain('Confirm delete');

    await act(async () => screen.root.findByProps({ testID: 'edit-host-host-live' }).props.onPress());
    expect(mocks.state.removeConnection).not.toHaveBeenCalled();
    expect(deleteButton().props.accessibilityLabel).not.toContain('Confirm delete');

    await act(async () => deleteButton().props.onPress());
    await act(async () => deleteButton().props.onPress());
    expect(mocks.state.removeConnection).toHaveBeenCalledWith('host-live');
  });

  it('uses QR pairing as the default and keeps manual credentials behind an advanced disclosure', async () => {
    const screen = renderScreen();

    const qrButton = screen.root.findByProps({ testID: 'qr-pairing-guide' });
    expect(qrButton.props.accessibilityRole).toBe('button');
    await act(async () => qrButton.props.onPress());
    expect(mocks.requestCameraPermission).toHaveBeenCalledTimes(1);
    expect(mocks.launchScanner).toHaveBeenCalledWith(expect.objectContaining({ barcodeTypes: ['qr'] }));

    await act(async () => {
      mocks.qrListener?.({
        data: 'https://relay.example.test/pair/mobile#code=0123456789abcdef0123456789abcdef',
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.dismissScanner).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith({
      pathname: '/pair',
      params: {
        origin: 'https://relay.example.test',
        code: '0123456789abcdef0123456789abcdef',
      },
    });
    expect(screen.root.findAllByProps({ testID: 'host-url-input' })).toHaveLength(0);
    await openAdvancedSetup(screen);
    expect(screen.root.findByProps({ testID: 'host-url-input' })).toBeTruthy();

    await act(async () => screen.root.findByProps({ testID: 'hosts-dismiss-keyboard' }).props.onPress());
    expect(mocks.dismissKeyboard).toHaveBeenCalledTimes(1);
  });

  it('keeps camera denial visible instead of making the QR action look inert', async () => {
    mocks.requestCameraPermission.mockResolvedValueOnce({ granted: false });
    const screen = renderScreen();

    await act(async () => screen.root.findByProps({ testID: 'qr-pairing-guide' }).props.onPress());

    expect(mocks.launchScanner).not.toHaveBeenCalled();
    expect(screen.root.findByProps({ testID: 'hosts-action-error' }).props.children).toContain('Camera');
  });

  it('turns the Simulator scanner failure into useful inline guidance', async () => {
    mocks.launchScanner.mockRejectedValueOnce(new Error("Modern barcode scanner is not available on this device"));
    const screen = renderScreen();

    await act(async () => screen.root.findByProps({ testID: 'qr-pairing-guide' }).props.onPress());

    expect(screen.root.findByProps({ testID: 'hosts-action-error' }).props.children)
      .toBe('QR scanning requires a camera-enabled iPhone');
  });
});

async function openAdvancedSetup(screen: ReactTestRenderer) {
  await act(async () => screen.root.findByProps({ testID: 'advanced-manual-setup-button' }).props.onPress());
}

function renderScreen() {
  let screen: ReactTestRenderer | undefined;
  act(() => {
    screen = create(<HostsScreen />);
  });
  return screen!;
}
