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
});
