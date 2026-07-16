import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ModelPickerModal } from './ModelPickerModal';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) => React.forwardRef(({ children, ...props }: any, ref) => React.createElement(name, { ...props, ref }, children));
  return {
    FlatList: ({ data = [], renderItem, keyExtractor, ...props }: any) => React.createElement(
      'FlatList',
      props,
      data.map((item: any, index: number) => React.createElement(React.Fragment, { key: keyExtractor(item, index) }, renderItem({ item, index }))),
    ),
    Keyboard: { dismiss: vi.fn() },
    Modal: ({ visible, children, ...props }: any) => visible ? React.createElement('Modal', props, children) : null,
    Pressable: host('Pressable'),
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

describe('ModelPickerModal', () => {
  it('applies the measured top inset inside a native full-screen modal', async () => {
    let screen!: ReactTestRenderer;
    await act(async () => {
      screen = create(
        <ModelPickerModal
          visible
          models={[]}
          onClose={() => undefined}
          onSelect={() => undefined}
        />,
      );
    });

    const safeArea = screen.root.findByProps({ testID: 'model-picker-safe-area' });
    expect(safeArea.props.edges).toEqual(['bottom', 'left', 'right']);
    expect(safeArea.props.style).toContainEqual({ paddingTop: 59 });
  });
});
