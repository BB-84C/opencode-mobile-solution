import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SessionScreen from '@/app/session/[sessionKey]';
import { encodeSessionRouteKey } from '@/src/ux/session-forest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const rootRef = { connectionId: 'relay', relayTargetID: 'mac', sessionId: 'root' };
const childRef = { ...rootRef, sessionId: 'child' };
const rootKey = JSON.stringify(['relay', 'mac', 'root']);
const childKey = JSON.stringify(['relay', 'mac', 'child']);
const scopeKey = JSON.stringify(['relay', 'mac', '/repo']);

const mocks = vi.hoisted(() => ({
  routeParams: { sessionKey: '' },
  replace: vi.fn(),
  clipboardRead: vi.fn(async () => 'clipboard'),
  clipboardWrite: vi.fn(async () => undefined),
  keyboardDismiss: vi.fn(),
  scrollToLatest: vi.fn(),
  state: {
    hydrated: true,
    connections: [{ id: 'relay', name: 'Relay', url: 'https://relay.test', authType: 'bearer', token: 'x', lastConnected: null, isReachable: true }],
    activeConnectionId: 'relay',
    activeSessionRef: { connectionId: 'relay', relayTargetID: 'mac', sessionId: 'root' },
    activeSessionKey: JSON.stringify(['relay', 'mac', 'root']),
    sessions: {
      relay: [
        { id: 'root', title: 'Root conversation', directory: '/repo', relayTargetID: 'mac', relayTargetName: 'MacBook', time: { updated: 20 } },
        { id: 'child', title: 'Child task', directory: '/repo', relayTargetID: 'mac', relayTargetName: 'MacBook', parentID: 'root', time: { updated: 30 } },
        { id: 'grandchild', title: 'Nested task', directory: '/repo', relayTargetID: 'mac', relayTargetName: 'MacBook', parentID: 'child', time: { updated: 40 } },
      ],
    },
    projects: { relay: [{ name: 'repo', directory: '/repo', sessionCount: 2 }] },
    sessionStatuses: {
      [JSON.stringify(['relay', 'mac', 'root'])]: { type: 'busy' },
      [JSON.stringify(['relay', 'mac', 'child'])]: { type: 'idle' },
    },
    messages: {
      [JSON.stringify(['relay', 'mac', 'root'])]: [
        { info: { id: 'm1', role: 'user', sessionID: 'root' }, parts: [{ type: 'text', text: 'hello root' }] },
        { info: { id: 'm2', role: 'assistant', sessionID: 'root' }, parts: [{ type: 'tool', tool: 'task', state: { metadata: { sessionId: 'child' } } }] },
      ],
      [JSON.stringify(['relay', 'mac', 'child'])]: [{ info: { id: 'm3', role: 'assistant', sessionID: 'child' }, parts: [{ type: 'text', text: 'child answer' }] }],
    },
    messageNextCursors: { [JSON.stringify(['relay', 'mac', 'root'])]: null } as Record<string, string | null>,
    olderMessageLoadStates: {} as Record<string, 'idle' | 'loading' | 'error'>,
    olderMessageErrors: {} as Record<string, string | null>,
    questions: {},
    sessionLoadStates: { [JSON.stringify(['relay', 'mac', 'root'])]: 'idle' },
    sessionErrors: {},
    eventConnectionStates: { [JSON.stringify(['relay', 'mac', 'root'])]: 'live' },
    machineContracts: {
      [JSON.stringify(['relay', 'mac', '/repo'])]: {
        connectionId: 'relay', relayTargetID: 'mac', directory: '/repo', fetchedAt: 'now',
        agents: [{ name: 'build', mode: 'primary' }, { name: 'explore', mode: 'subagent' }],
        providers: [{ id: 'openai', name: 'OpenAI', models: { 'gpt-5.5': { id: 'gpt-5.5', providerID: 'openai', name: 'GPT 5.5', variants: { high: {}, xhigh: {} } } } }],
        providerDefaults: { openai: 'gpt-5.5' },
        commands: [{ name: 'review', description: 'Review changes' }],
      },
    },
    contractLoadStates: {
      [JSON.stringify(['relay', 'mac', '/repo'])]: { status: 'fresh', attemptedAt: 'now', verifiedAt: 'now', error: null as string | null },
    },
    sessionSelections: {
      [JSON.stringify(['relay', 'mac', 'root'])]: { agentName: 'build', model: { providerID: 'openai', modelID: 'gpt-5.5' }, variant: 'xhigh' },
      [JSON.stringify(['relay', 'mac', 'child'])]: { agentName: 'build', model: { providerID: 'openai', modelID: 'gpt-5.5' }, variant: 'high' },
    },
    promptMode: 'ask',
    setActiveConnection: vi.fn(() => true),
    openSession: vi.fn(async () => undefined),
    loadOlderMessages: vi.fn(async () => undefined),
    subscribeToActiveHost: vi.fn(),
    unsubscribeFromHost: vi.fn(),
    searchFileReferences: vi.fn(async () => []),
    sendPrompt: vi.fn(async () => 'root'),
    respondToPermission: vi.fn(async () => undefined),
    respondToQuestion: vi.fn(async () => undefined),
    rejectQuestion: vi.fn(async () => undefined),
    revertMessage: vi.fn(async () => undefined),
    unrevertSession: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    shareSession: vi.fn(async () => 'https://share.test/root'),
    compactSession: vi.fn(async () => undefined),
    copySessionTranscript: vi.fn(() => '[user]\nhello root'),
    setSessionAgent: vi.fn(() => true),
    setSessionModel: vi.fn(() => true),
    setSessionVariant: vi.fn(() => true),
    togglePromptMode: vi.fn(),
    requestInterrupt: vi.fn(async () => 'armed'),
  },
}));

vi.mock('expo-router', () => ({
  router: { replace: mocks.replace },
  useLocalSearchParams: () => mocks.routeParams,
}));

vi.mock('expo-clipboard', () => ({
  getStringAsync: mocks.clipboardRead,
  setStringAsync: mocks.clipboardWrite,
}));

vi.mock('expo-symbols', async () => {
  const React = await import('react');
  return { SymbolView: (props: Record<string, unknown>) => React.createElement('SymbolView', props) };
});

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) => React.forwardRef(({ children, ...props }: any, ref) => React.createElement(name, { ...props, ref }, children));
  const Modal = ({ visible, children, ...props }: any) => visible ? React.createElement('Modal', props, children) : null;
  return {
    ActivityIndicator: host('ActivityIndicator'),
    FlatList: host('FlatList'),
    Keyboard: { dismiss: mocks.keyboardDismiss },
    KeyboardAvoidingView: host('KeyboardAvoidingView'),
    Modal,
    Platform: { OS: 'ios', select: (options: any) => options.ios ?? options.default },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    TextInput: host('TextInput'),
    View: host('View'),
  };
});

vi.mock('react-native-safe-area-context', async () => {
  const React = await import('react');
  return {
    SafeAreaView: ({ children, ...props }: any) => React.createElement('SafeAreaView', props, children),
    useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
  };
});

vi.mock('@/src/store/mobile-store', () => ({
  decodeSessionStateKey: (key: string) => {
    try {
      const [connectionId, relayTargetID, sessionId] = JSON.parse(key);
      return { connectionId, relayTargetID, sessionId };
    } catch { return undefined; }
  },
  executionScopeKey: (ref: any, directory?: string) => JSON.stringify([ref.connectionId, ref.relayTargetID, directory ?? '']),
  sessionStateKey: (ref: any) => JSON.stringify([ref.connectionId, ref.relayTargetID, ref.sessionId]),
  useOpenCodeMobileStore: (selector?: (state: typeof mocks.state) => unknown) => selector ? selector(mocks.state) : mocks.state,
}));

vi.mock('@/src/components/opencode/VirtualizedTranscript', async () => {
  const React = await import('react');
  return {
    VirtualizedTranscript: React.forwardRef(({ data, renderItem, isLoading, onBottomStateChange, onOlderEndReached, testID = 'session-transcript' }: any, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToLatest: mocks.scrollToLatest }));
      return React.createElement(
        'VirtualizedTranscript',
        {
          testID,
          isLoading,
          onBottomStateChange,
          onOlderEndReached,
          dataLength: data.length,
          firstMessageID: data[0]?.info.id,
          lastMessageID: data.at(-1)?.info.id,
        },
        data.map((item: any, index: number) => React.createElement(React.Fragment, { key: item.info.id }, renderItem({ item, index }))),
      );
    }),
  };
});

vi.mock('@/src/components/opencode/MessageCard', async () => {
  const React = await import('react');
  return {
    MessageCard: ({ message, onOpenSubagent, allowFork }: any) => {
      const child = message.parts.find((part: any) => part.tool === 'task')?.state?.metadata?.sessionId;
      return React.createElement(
        'MessageCard',
        { testID: `message-card-${message.info.id}`, allowFork },
        React.createElement('Text', null, message.parts.map((part: any) => part.text ?? '').join('')),
        child ? React.createElement('Pressable', { testID: `open-child-${child}`, onPress: () => onOpenSubagent(child) }) : null,
      );
    },
  };
});

vi.mock('@/src/components/opencode/ActionModal', async () => {
  const React = await import('react');
  return {
    ActionModal: ({ visible, items, title }: any) => visible ? React.createElement(
      'ActionModal',
      { testID: `modal-${title}` },
      items.map((item: any) => React.createElement(
        'Pressable',
        { key: item.id, testID: `action-${item.id}`, onPress: item.onPress, disabled: item.disabled },
        React.createElement('Text', null, item.label),
        item.detail ? React.createElement('Text', null, item.detail) : null,
      )),
    ) : null,
  };
});

describe('SessionScreen composite route', () => {
  beforeEach(() => {
    mocks.state.hydrated = true;
    mocks.routeParams = { sessionKey: encodeSessionRouteKey(rootRef) };
    mocks.replace.mockReset();
    mocks.clipboardRead.mockClear();
    mocks.scrollToLatest.mockClear();
    mocks.state.openSession.mockClear();
    mocks.state.loadOlderMessages.mockClear();
    mocks.state.subscribeToActiveHost.mockClear();
    mocks.state.unsubscribeFromHost.mockClear();
    mocks.state.sendPrompt.mockReset();
    mocks.state.sendPrompt.mockResolvedValue('root');
    mocks.state.activeSessionRef = rootRef;
    mocks.state.activeSessionKey = rootKey;
    mocks.state.sessionLoadStates = { [rootKey]: 'idle' };
    mocks.state.sessionErrors = {};
    mocks.state.eventConnectionStates = { [rootKey]: 'live' };
    mocks.state.contractLoadStates = {
      [scopeKey]: { status: 'fresh', attemptedAt: 'now', verifiedAt: 'now', error: null },
    };
    mocks.state.messages[rootKey] = [
      { info: { id: 'm1', role: 'user', sessionID: 'root' }, parts: [{ type: 'text', text: 'hello root' }] },
      { info: { id: 'm2', role: 'assistant', sessionID: 'root' }, parts: [{ type: 'tool', tool: 'task', state: { metadata: { sessionId: 'child' } } }] },
    ];
    mocks.state.messageNextCursors = { [rootKey]: null };
    mocks.state.olderMessageLoadStates = {};
    mocks.state.olderMessageErrors = {};
  });

  it('opens the exact machine-scoped ref, subscribes, and never reads the clipboard on mount', async () => {
    const screen = await renderScreen();
    expect(mocks.state.openSession).toHaveBeenCalledWith(rootRef);
    expect(mocks.state.subscribeToActiveHost).toHaveBeenCalled();
    expect(mocks.clipboardRead).not.toHaveBeenCalled();
    expect(text(screen)).toContain('Root conversation');
    expect(text(screen)).toContain('hello root');
    expect(text(screen)).toContain('build');
    expect(text(screen)).toContain('GPT 5.5');
    expect(text(screen)).toContain('xhigh');
  });

  it('shows a neutral loading surface instead of a false relay error before hydration', async () => {
    mocks.state.hydrated = false;
    const connections = mocks.state.connections;
    mocks.state.connections = [];
    const screen = await renderScreen();

    expect(find(screen, 'session-route-loading')).toBeTruthy();
    expect(text(screen)).not.toContain('Relay unavailable');
    expect(mocks.state.openSession).not.toHaveBeenCalled();
    mocks.state.connections = connections;
  });

  it('shows a one-tap latest-message control only while the reader is away from the bottom', async () => {
    const screen = await renderScreen();
    const transcript = find(screen, 'session-transcript');

    await act(async () => transcript.props.onBottomStateChange(false));
    await act(async () => find(screen, 'session-scroll-to-latest').props.onPress());
    expect(mocks.scrollToLatest).toHaveBeenCalledTimes(1);

    await act(async () => transcript.props.onBottomStateChange(true));
    expect(all(screen, 'session-scroll-to-latest')).toHaveLength(0);
  });

  it('renders a bounded latest window and reveals older history without replacing the latest edge', async () => {
    mocks.state.messages[rootKey] = Array.from({ length: 231 }, (_, index) => ({
      info: { id: `m-${index}`, role: 'assistant' as const, sessionID: 'root', time: { created: index } },
      parts: [{ type: 'text' as const, text: `message ${index}` }],
    }));
    const screen = await renderScreen();

    expect(find(screen, 'session-transcript').props).toMatchObject({
      dataLength: 100,
      firstMessageID: 'm-131',
      lastMessageID: 'm-230',
    });

    await act(async () => find(screen, 'session-transcript').props.onOlderEndReached());
    expect(find(screen, 'session-transcript').props).toMatchObject({
      dataLength: 200,
      firstMessageID: 'm-31',
      lastMessageID: 'm-230',
    });

    await act(async () => find(screen, 'session-transcript').props.onOlderEndReached());
    expect(find(screen, 'session-transcript').props).toMatchObject({
      dataLength: 231,
      firstMessageID: 'm-0',
      lastMessageID: 'm-230',
    });
  });

  it('shows a blocking loader and does not mislabel an ordinary refresh failure as offline', async () => {
    mocks.state.sessionLoadStates = { [rootKey]: 'loading' };
    mocks.state.sessionErrors = { [rootKey]: 'diff endpoint failed' };
    const transcript = mocks.state.messages[rootKey];
    mocks.state.messages[rootKey] = [];
    const screen = await renderScreen();
    expect(find(screen, 'session-loading-blocker')).toBeTruthy();
    expect(find(screen, 'session-load-warning')).toBeTruthy();
    expect(all(screen, 'session-offline-cache-banner')).toHaveLength(0);
    mocks.state.messages[rootKey] = transcript;
  });

  it('uses replace for parent/child navigation and never grows a push stack', async () => {
    let screen = await renderScreen();
    await act(async () => find(screen, 'open-child-child').props.onPress());
    expect(mocks.replace).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/session/[sessionKey]' }));

    mocks.routeParams = { sessionKey: encodeSessionRouteKey(childRef) };
    mocks.state.activeSessionRef = childRef;
    mocks.state.activeSessionKey = childKey;
    screen.unmount();
    screen = await renderScreen();
    await act(async () => find(screen, 'session-back-button').props.onPress());
    expect(mocks.replace).toHaveBeenLastCalledWith(expect.objectContaining({ params: { sessionKey: encodeSessionRouteKey(rootRef) } }));
  });

  it('returns a root session directly to the Sessions tab', async () => {
    const screen = await renderScreen();
    await act(async () => find(screen, 'session-back-button').props.onPress());
    expect(mocks.replace).toHaveBeenCalledWith('/two');
  });

  it('does not expose fork and sends only through the already active session', async () => {
    const screen = await renderScreen();
    await act(async () => find(screen, 'session-overflow-button').props.onPress());
    expect(all(screen, 'action-fork')).toHaveLength(0);
    expect(find(screen, 'message-card-m1').props.allowFork).toBe(false);

    await act(async () => find(screen, 'session-prompt-input').props.onChangeText('continue existing')); 
    await act(async () => find(screen, 'send-prompt-button').props.onPress());
    expect(mocks.state.sendPrompt).toHaveBeenCalledWith('continue existing');
  });

  it('renders the complete conversation component at arbitrary depth', async () => {
    const screen = await renderScreen();
    await act(async () => find(screen, 'session-hierarchy-button').props.onPress());
    expect(find(screen, `action-tree-${rootKey}`)).toBeTruthy();
    expect(find(screen, `action-tree-${childKey}`)).toBeTruthy();
    expect(find(screen, `action-tree-${JSON.stringify(['relay', 'mac', 'grandchild'])}`)).toBeTruthy();
    expect(text(screen)).toContain('Nested task');
    expect(text(screen)).toContain('Depth 2');
  });

  it('keeps cached controls visible but blocks send until the machine contract is freshly verified', async () => {
    mocks.state.contractLoadStates = {
      [scopeKey]: { status: 'stale', attemptedAt: 'now', verifiedAt: 'before', error: 'target unavailable' },
    };
    const screen = await renderScreen();
    expect(find(screen, 'session-contract-warning')).toBeTruthy();
    await act(async () => find(screen, 'session-prompt-input').props.onChangeText('must not dispatch'));
    expect(find(screen, 'send-prompt-button').props.disabled).toBe(true);
    await act(async () => find(screen, 'send-prompt-button').props.onPress());
    expect(mocks.state.sendPrompt).not.toHaveBeenCalled();
  });

  it('reports true live-stream disconnection without hiding the transcript', async () => {
    mocks.state.eventConnectionStates = { [rootKey]: 'offline' };
    const screen = await renderScreen();
    expect(find(screen, 'session-offline-cache-banner')).toBeTruthy();
    expect(text(screen)).toContain('hello root');
  });

  it('requests the next server page when the local transcript window is exhausted', async () => {
    mocks.state.messageNextCursors = { [rootKey]: 'older-page' };
    const screen = await renderScreen();

    await act(async () => find(screen, 'session-transcript').props.onOlderEndReached());

    expect(mocks.state.loadOlderMessages).toHaveBeenCalledWith(rootRef);
  });
});

async function renderScreen() {
  let screen!: ReactTestRenderer;
  await act(async () => { screen = create(<SessionScreen />); });
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
