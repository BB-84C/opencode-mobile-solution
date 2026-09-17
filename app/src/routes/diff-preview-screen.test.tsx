import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import DiffPreviewScreen from '@/app/diff-preview';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) => ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement(name, props, children);
  return {
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: {
      create: <T extends Record<string, unknown>>(styles: T) => styles,
      hairlineWidth: 1,
    },
    Text: host('Text'),
    View: host('View'),
  };
});

vi.mock('@/src/components/opencode/ActionModal', () => ({ ActionModal: () => null }));
vi.mock('@/src/components/opencode/TextViewModal', () => ({ TextViewModal: () => null }));
vi.mock('@/src/ux/clipboard', () => ({ writeClipboardText: vi.fn() }));

const routeMocks = vi.hoisted(() => ({
  params: {} as Record<string, string | undefined>,
  diffs: {} as Record<string, unknown[]>,
}));

vi.mock('expo-router', () => ({ useLocalSearchParams: () => routeMocks.params }));

vi.mock('@/src/store/mobile-store', () => ({
  sessionStateKey: (ref: { connectionId: string; relayTargetID?: string; sessionId: string }) =>
    `${ref.connectionId}::${ref.relayTargetID ?? ''}::${ref.sessionId}`,
  useOpenCodeMobileStore: (selector: (state: unknown) => unknown) =>
    selector({ diffs: routeMocks.diffs }),
}));

describe('DiffPreviewScreen layout', () => {
  it('stretches and left-aligns the header so the subtitle cannot be clipped from the leading edge', () => {
    let screen: ReturnType<typeof create> | undefined;
    act(() => {
      screen = create(<DiffPreviewScreen />);
    });

    expect(screen!.root.findByProps({ testID: 'diff-preview-header' }).props.style).toMatchObject({
      alignSelf: 'stretch',
      width: '100%',
    });
    expect(screen!.root.findByProps({ testID: 'diff-preview-subtitle' }).props.style).toMatchObject({
      alignSelf: 'stretch',
      textAlign: 'left',
    });
    expect(screen!.root.findByProps({ testID: 'diff-preview-title' }).props.style).toMatchObject({ fontSize: 20 });
  });

  it('shows the session it was opened for, not whichever session is active', () => {
    routeMocks.params = { connectionId: 'relay', machine: 'mac', session: 'ses_1' };
    routeMocks.diffs = {
      'relay::mac::ses_1': [{ path: 'a.ts', hunks: [] }],
      'relay::mac::ses_other': [{ path: 'b.ts', hunks: [] }, { path: 'c.ts', hunks: [] }],
    };
    let screen: ReturnType<typeof create> | undefined;
    act(() => { screen = create(<DiffPreviewScreen />); });

    const subtitle = screen!.root.findByProps({ testID: 'diff-preview-subtitle' });
    expect(String(subtitle.props.children)).toContain('1 changed file');
  });

  it('says a session has no changes rather than falling back to the fixture', () => {
    routeMocks.params = { connectionId: 'relay', machine: 'mac', session: 'ses_empty' };
    routeMocks.diffs = {};
    let screen: ReturnType<typeof create> | undefined;
    act(() => { screen = create(<DiffPreviewScreen />); });

    const subtitle = screen!.root.findByProps({ testID: 'diff-preview-subtitle' });
    expect(String(subtitle.props.children)).toContain('No file changes recorded');
  });

  it('keeps the local fixture when opened without a session, for copy QA', () => {
    routeMocks.params = {};
    routeMocks.diffs = {};
    let screen: ReturnType<typeof create> | undefined;
    act(() => { screen = create(<DiffPreviewScreen />); });

    const subtitle = screen!.root.findByProps({ testID: 'diff-preview-subtitle' });
    expect(String(subtitle.props.children)).toContain('Local fixture');
  });
});
