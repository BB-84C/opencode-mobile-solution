import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createRef } from 'react';
import { Text } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VirtualizedTranscript, type VirtualizedTranscriptHandle } from './VirtualizedTranscript';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Item = { id: string; text: string };

const mocks = vi.hoisted(() => ({
  frameCallbacks: new Map<number, FrameRequestCallback>(),
  nextFrame: 1,
  scrollToOffset: vi.fn(),
}));

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) =>
    React.forwardRef<unknown, Record<string, unknown> & { children?: React.ReactNode }>(({ children, ...props }, ref) =>
      React.createElement(name, { ...props, ref } as any, children as any),
    );
  const renderOptionalComponent = (component: unknown) => {
    if (React.isValidElement(component)) return component;
    if (typeof component === 'function') return React.createElement(component as React.ComponentType);
    return null;
  };
  const FlatList = React.forwardRef(
    (
      props: Record<string, any> & {
        data?: Item[];
        renderItem?: (info: { item: Item; index: number; separators: unknown }) => React.ReactNode;
        keyExtractor?: (item: Item, index: number) => string;
      },
      ref,
    ) => {
      React.useImperativeHandle(ref, () => ({
        scrollToOffset: mocks.scrollToOffset,
      }));
      const rows: React.ReactNode[] = (props.data ?? []).map((item, index) =>
        React.createElement(
          React.Fragment,
          { key: props.keyExtractor?.(item, index) ?? String(index) },
          props.renderItem?.({ item, index, separators: {} }),
        ),
      );
      const empty = renderOptionalComponent(props.ListEmptyComponent);
      const footer = renderOptionalComponent(props.ListFooterComponent);
      if (rows.length === 0 && empty) rows.push(empty);
      if (props.ListFooterComponent && footer) rows.push(footer);
      return React.createElement('FlatList', props, rows);
    },
  );

  return {
    ActivityIndicator: host('ActivityIndicator'),
    FlatList,
    StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
    Text: host('Text'),
    View: host('View'),
  };
});

function renderItem({ item }: { item: Item }) {
  return <TextRow id={item.id} text={item.text} />;
}

function TextRow({ id, text }: Item) {
  return <Text testID={`row-${id}`}>{text}</Text>;
}

function flushAnimationFrames() {
  const pending = [...mocks.frameCallbacks.entries()];
  mocks.frameCallbacks.clear();
  for (const [, callback] of pending) callback(performance.now());
}

function nativeScroll({ contentHeight, viewportHeight, offsetY }: { contentHeight: number; viewportHeight: number; offsetY: number }) {
  return {
    nativeEvent: {
      contentOffset: { x: 0, y: offsetY },
      contentSize: { width: 390, height: contentHeight },
      layoutMeasurement: { width: 390, height: viewportHeight },
    },
  };
}

describe('VirtualizedTranscript', () => {
  beforeEach(() => {
    mocks.frameCallbacks.clear();
    mocks.nextFrame = 1;
    mocks.scrollToOffset.mockReset();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = mocks.nextFrame++;
      mocks.frameCallbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      mocks.frameCallbacks.delete(id);
    });
  });

  it('uses bounded FlatList rendering and exposes a stable transcript test id', async () => {
    let screen: ReactTestRenderer | undefined;
    await act(async () => {
      screen = create(
        <VirtualizedTranscript
          transcriptKey="host:session-1"
          data={[{ id: 'm1', text: 'hello' }]}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
        />,
      );
    });

    const list = screen!.root.findByType('FlatList' as any);
    expect(list.props).toMatchObject({
      testID: 'session-transcript',
      initialNumToRender: 12,
      maxToRenderPerBatch: 8,
      updateCellsBatchingPeriod: 40,
      windowSize: 7,
      removeClippedSubviews: false,
      inverted: true,
      maintainVisibleContentPosition: { minIndexForVisible: 0, autoscrollToTopThreshold: 1 },
      onEndReachedThreshold: 0.25,
      scrollEventThrottle: 32,
      showsVerticalScrollIndicator: false,
    });
    // onEndReached expands only the bounded older-history render window. It is
    // never used as proof that UIKit reached the latest native offset.
    expect(list.props.onEndReached).toEqual(expect.any(Function));
    expect(screen!.root.findByProps({ testID: 'row-m1' })).toBeTruthy();
  });

  it('reports the older edge without issuing a scroll command', async () => {
    const onOlderEndReached = vi.fn();
    let screen: ReactTestRenderer | undefined;
    await act(async () => {
      screen = create(
        <VirtualizedTranscript
          transcriptKey="host:older-window"
          data={[{ id: 'm1', text: 'one' }, { id: 'm2', text: 'two' }]}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          onOlderEndReached={onOlderEndReached}
        />,
      );
    });

    const list = screen!.root.findByType('FlatList' as any);
    await act(async () => list.props.onEndReached());

    expect(onOlderEndReached).toHaveBeenCalledOnce();
    expect(mocks.scrollToOffset).not.toHaveBeenCalled();
  });

  it('keeps FlatList props stable across parent-only renders and invokes the latest renderer for changed data', async () => {
    const initialData = [{ id: 'm1', text: 'hello' }];
    const initialExtraData = { showActions: true, status: undefined };
    let screen: ReactTestRenderer | undefined;
    await act(async () => {
      screen = create(
        <VirtualizedTranscript
          transcriptKey="host:stable"
          data={initialData}
          extraData={initialExtraData}
          renderItem={({ item }) => <Text testID={`row-${item.id}`}>{`first:${item.text}`}</Text>}
          keyExtractor={(item) => item.id}
        />,
      );
    });
    const firstProps = screen!.root.findByType('FlatList' as any).props;

    await act(async () => {
      screen!.update(
        <VirtualizedTranscript
          transcriptKey="host:stable"
          data={initialData}
          extraData={{ showActions: true, status: undefined }}
          renderItem={({ item }) => <Text testID={`row-${item.id}`}>{`second:${item.text}`}</Text>}
          keyExtractor={(item) => item.id}
        />,
      );
    });
    const stableProps = screen!.root.findByType('FlatList' as any).props;
    expect(stableProps.renderItem).toBe(firstProps.renderItem);
    expect(stableProps.keyExtractor).toBe(firstProps.keyExtractor);
    expect(stableProps.extraData).toBe(firstProps.extraData);
    expect(stableProps.contentContainerStyle).toBe(firstProps.contentContainerStyle);
    expect(stableProps.ListEmptyComponent).toBe(firstProps.ListEmptyComponent);
    expect(stableProps.maintainVisibleContentPosition).toBe(firstProps.maintainVisibleContentPosition);
    expect(stableProps.onLayout).toBe(firstProps.onLayout);

    await act(async () => {
      screen!.update(
        <VirtualizedTranscript
          transcriptKey="host:stable"
          data={[{ id: 'm1', text: 'updated' }]}
          extraData={{ showActions: false, status: undefined }}
          renderItem={({ item }) => <Text testID={`row-${item.id}`}>{`latest:${item.text}`}</Text>}
          keyExtractor={(item) => item.id}
        />,
      );
    });
    const changedProps = screen!.root.findByType('FlatList' as any).props;
    expect(changedProps.renderItem).toBe(firstProps.renderItem);
    expect(changedProps.extraData).not.toBe(firstProps.extraData);
    expect(screen!.root.findByProps({ testID: 'row-m1' }).props.children).toBe('latest:updated');
  });

  it('renders distinct loading and empty states', async () => {
    let screen: ReactTestRenderer | undefined;
    await act(async () => {
      screen = create(
        <VirtualizedTranscript
          transcriptKey="host:loading"
          data={[]}
          isLoading
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
        />,
      );
    });
    expect(screen!.root.findByProps({ testID: 'session-transcript-loading' })).toBeTruthy();

    await act(async () => {
      screen!.update(
        <VirtualizedTranscript
          transcriptKey="host:loading"
          data={[]}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
        />,
      );
    });
    expect(screen!.root.findByProps({ testID: 'session-transcript-empty' })).toBeTruthy();
  });

  it('renders newest content at native offset zero and leaves history reading undisturbed', async () => {
    const initial = [
      { id: 'm1', text: 'one' },
      { id: 'm2', text: 'two' },
    ];
    let screen: ReactTestRenderer | undefined;
    await act(async () => {
      screen = create(
        <VirtualizedTranscript
          transcriptKey="host:session-1"
          data={initial}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
        />,
      );
    });
    let list = screen!.root.findByType('FlatList' as any);

    expect(list.props.data.map((item: Item) => item.id)).toEqual(['m2', 'm1']);
    expect(mocks.scrollToOffset).not.toHaveBeenCalled();

    await act(async () => {
      list.props.onScroll(nativeScroll({ contentHeight: 1200, viewportHeight: 400, offsetY: 0 }));
      list.props.onViewableItemsChanged({
        viewableItems: [{ item: initial[1], index: 0, key: 'm2', isViewable: true }],
        changed: [],
      });
    });
    expect(mocks.scrollToOffset).not.toHaveBeenCalled();

    await act(async () => {
      list.props.onScrollBeginDrag();
      list.props.onScroll(nativeScroll({ contentHeight: 1200, viewportHeight: 400, offsetY: 550 }));
      list.props.onScrollEndDrag();
      screen!.update(
        <VirtualizedTranscript
          transcriptKey="host:session-1"
          data={[...initial, { id: 'm3', text: 'streamed' }]}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
        />,
      );
    });
    list = screen!.root.findByType('FlatList' as any);
    expect(list.props.data.map((item: Item) => item.id)).toEqual(['m3', 'm2', 'm1']);
    expect(mocks.scrollToOffset).not.toHaveBeenCalled();
  });

  it('exposes one immediate latest-message jump and waits for native bottom confirmation', async () => {
    const transcriptRef = createRef<VirtualizedTranscriptHandle>();
    const onBottomStateChange = vi.fn();
    let screen: ReactTestRenderer | undefined;
    await act(async () => {
      screen = create(
        <VirtualizedTranscript
          ref={transcriptRef}
          transcriptKey="host:manual-follow"
          data={[{ id: 'm1', text: 'one' }, { id: 'm2', text: 'two' }]}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          onBottomStateChange={onBottomStateChange}
        />,
      );
    });
    const list = screen!.root.findByType('FlatList' as any);

    await act(async () => {
      list.props.onScroll(nativeScroll({ contentHeight: 1200, viewportHeight: 400, offsetY: 0 }));
      expect(onBottomStateChange).toHaveBeenLastCalledWith(true);
      list.props.onViewableItemsChanged({
        viewableItems: [{ item: { id: 'm2', text: 'two' }, index: 0, key: 'm2', isViewable: true }],
        changed: [],
      });
      list.props.onScroll(nativeScroll({ contentHeight: 1200, viewportHeight: 400, offsetY: 550 }));
    });
    expect(onBottomStateChange).toHaveBeenLastCalledWith(false);

    await act(async () => {
      transcriptRef.current!.scrollToLatest();
      flushAnimationFrames();
    });
    expect(mocks.scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });
    expect(mocks.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(onBottomStateChange).toHaveBeenLastCalledWith(false);

    await act(async () => {
      list.props.onScroll(nativeScroll({ contentHeight: 1200, viewportHeight: 400, offsetY: 200 }));
      flushAnimationFrames();
    });
    expect(mocks.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(onBottomStateChange).toHaveBeenLastCalledWith(false);

    await act(async () => {
      list.props.onScroll(nativeScroll({ contentHeight: 1200, viewportHeight: 400, offsetY: 0 }));
    });
    expect(onBottomStateChange).toHaveBeenLastCalledWith(true);
  });

  it('reports visible ranges only when the range changes', async () => {
    const onVisibleRangeChange = vi.fn();
    let screen: ReactTestRenderer | undefined;
    await act(async () => {
      screen = create(
        <VirtualizedTranscript
          transcriptKey="host:session-1"
          data={[
            { id: 'm1', text: 'one' },
            { id: 'm2', text: 'two' },
          ]}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          onVisibleRangeChange={onVisibleRangeChange}
        />,
      );
    });
    const list = screen!.root.findByType('FlatList' as any);
    const payload = {
      viewableItems: [{ item: { id: 'm2', text: 'two' }, index: 0, key: 'm2', isViewable: true }],
      changed: [],
    };

    await act(async () => {
      list.props.onViewableItemsChanged(payload);
      list.props.onViewableItemsChanged(payload);
    });

    expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
    expect(onVisibleRangeChange).toHaveBeenCalledWith({
      firstIndex: 1,
      lastIndex: 1,
      firstKey: 'm2',
      lastKey: 'm2',
    });
  });
});
