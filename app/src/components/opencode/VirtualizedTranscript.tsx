import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type ForwardedRef,
  type ReactElement,
  type RefAttributes,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
  type ViewToken,
} from 'react-native';

import { palette } from '@/src/ui/palette';
import {
  createTranscriptFollowState,
  reduceTranscriptFollow,
  type TranscriptFollowDecision,
} from '@/src/ux/transcript-follow';
import {
  isTranscriptScrollNoop,
  nextTranscriptOffset,
  type TranscriptMetrics,
  type TranscriptScrollCommand,
} from '@/src/ux/transcript-scroll-commands';

export type TranscriptVisibleRange = {
  firstIndex: number | null;
  lastIndex: number | null;
  firstKey: string | null;
  lastKey: string | null;
};

export type VirtualizedTranscriptProps<ItemT> = {
  transcriptKey: string;
  data: readonly ItemT[];
  renderItem: ListRenderItem<ItemT>;
  keyExtractor: (item: ItemT, index: number) => string;
  isLoading?: boolean;
  loadingLabel?: string;
  emptyLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  extraData?: unknown;
  onVisibleRangeChange?: (range: TranscriptVisibleRange) => void;
  onBottomStateChange?: (atBottom: boolean) => void;
  onOlderEndReached?: () => void;
};

export type VirtualizedTranscriptHandle = {
  scrollToLatest(): void;
  /** Returns false when already at that end, so a key can say so. */
  scroll(command: TranscriptScrollCommand): boolean;
};

/**
 * A transcript-specific FlatList wrapper. The component owns viewport
 * following in refs, so high-frequency native scroll events do not cause React
 * renders. Message presentation stays with the caller through renderItem.
 */
function VirtualizedTranscriptInner<ItemT>({
  transcriptKey,
  data,
  renderItem,
  keyExtractor,
  isLoading = false,
  loadingLabel = 'Loading transcript...',
  emptyLabel = 'No messages yet',
  testID = 'session-transcript',
  style,
  contentContainerStyle,
  extraData,
  onVisibleRangeChange,
  onBottomStateChange,
  onOlderEndReached,
}: VirtualizedTranscriptProps<ItemT>, forwardedRef: ForwardedRef<VirtualizedTranscriptHandle>) {
  const listRef = useRef<FlatList<ItemT>>(null);
  // Raw geometry for keyboard scrolling; the follow reducer answers a different question.
  const metricsRef = useRef<TranscriptMetrics>({ offsetY: 0, viewportHeight: 0, contentHeight: 0 });
  const followStateRef = useRef(createTranscriptFollowState());
  const lastReportedBottomRef = useRef<boolean | null>(null);
  const dataLengthRef = useRef(data.length);
  const visibleRangeSignatureRef = useRef<string | null>(null);
  const onVisibleRangeChangeRef = useRef(onVisibleRangeChange);
  const onBottomStateChangeRef = useRef(onBottomStateChange);
  const onOlderEndReachedRef = useRef(onOlderEndReached);
  const renderItemRef = useRef(renderItem);
  const keyExtractorRef = useRef(keyExtractor);

  onVisibleRangeChangeRef.current = onVisibleRangeChange;
  onBottomStateChangeRef.current = onBottomStateChange;
  onOlderEndReachedRef.current = onOlderEndReached;
  renderItemRef.current = renderItem;
  keyExtractorRef.current = keyExtractor;
  dataLengthRef.current = data.length;

  // Parent screens can render on every streamed message fragment. Keep the
  // FlatList function props stable while still invoking their latest behavior;
  // this lets FlatList's own PureComponent boundary ignore unrelated updates.
  const stableRenderItem = useCallback<ListRenderItem<ItemT>>(
    (info) => renderItemRef.current({
      ...info,
      index: dataLengthRef.current - 1 - info.index,
    }),
    [],
  );
  const stableKeyExtractor = useCallback(
    (item: ItemT, index: number) => keyExtractorRef.current(item, dataLengthRef.current - 1 - index),
    [],
  );
  const invertedData = useMemo(() => [...data].reverse(), [data]);
  const stableExtraData = useShallowStableValue(extraData);
  const mergedContentContainerStyle = useMemo(
    () => [styles.content, contentContainerStyle],
    [contentContainerStyle],
  );

  const commitFollowDecision = useCallback((decision: TranscriptFollowDecision) => {
    followStateRef.current = decision.state;
    if (!decision.state.didInitialScroll || lastReportedBottomRef.current === decision.state.atBottom) return;
    lastReportedBottomRef.current = decision.state.atBottom;
    onBottomStateChangeRef.current?.(decision.state.atBottom);
  }, []);

  const confirmInitialFollowIfReady = useCallback(() => {
    const current = followStateRef.current;
    if (
      current.didInitialScroll
      || current.userInteracting
      || !current.atBottom
      || dataLengthRef.current === 0
    ) return;
    commitFollowDecision(reduceTranscriptFollow(current, { type: 'initial-settled' }));
  }, [commitFollowDecision]);

  useImperativeHandle(forwardedRef, () => ({
    scroll(command: TranscriptScrollCommand) {
      if (isTranscriptScrollNoop(command, metricsRef.current)) return false;
      const offset = nextTranscriptOffset(command, metricsRef.current);

      // Key repeat outruns the native scroll event; reading the stale offset
      // would make every press after the first a no-op.
      metricsRef.current = { ...metricsRef.current, offsetY: offset };

      if (offset === 0) {
        commitFollowDecision(reduceTranscriptFollow(followStateRef.current, { type: 'request-follow' }));
      }
      listRef.current?.scrollToOffset({ offset, animated: false });
      return true;
    },
    scrollToLatest() {
      const decision = reduceTranscriptFollow(followStateRef.current, { type: 'request-follow' });
      commitFollowDecision(decision);
      if (decision.shouldJumpToLatest) {
        // Inverted FlatList makes the newest content native offset zero. A
        // non-animated jump is distance-independent and cannot be chased by
        // intermediate animation events, which keeps this one tap immediate
        // and deterministic even for very long transcripts.
        listRef.current?.scrollToOffset({ offset: 0, animated: false });
      }
    },
  }), [commitFollowDecision]);

  useLayoutEffect(() => {
    followStateRef.current = createTranscriptFollowState();
    lastReportedBottomRef.current = null;
    visibleRangeSignatureRef.current = null;
  }, [transcriptKey]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const distanceFromLatest = Math.max(0, contentOffset.y);
      metricsRef.current = {
        offsetY: distanceFromLatest,
        viewportHeight: layoutMeasurement.height,
        contentHeight: contentSize.height,
      };
      const decision = reduceTranscriptFollow(followStateRef.current, {
        type: 'scroll',
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
        offsetY: distanceFromLatest,
        atBottom: distanceFromLatest <= latestThreshold,
      });
      commitFollowDecision(decision);
      confirmInitialFollowIfReady();
    },
    [commitFollowDecision, confirmInitialFollowIfReady],
  );

  const setUserInteraction = useCallback(
    (active: boolean) => {
      commitFollowDecision(reduceTranscriptFollow(followStateRef.current, { type: 'interaction', active }));
    },
    [commitFollowDecision],
  );
  const handleLayout = useCallback(
    (event: { nativeEvent: { layout: { height: number } } }) => {
      metricsRef.current = { ...metricsRef.current, viewportHeight: event.nativeEvent.layout.height };
      commitFollowDecision(
        reduceTranscriptFollow(followStateRef.current, {
          type: 'layout',
          viewportHeight: event.nativeEvent.layout.height,
        }),
      );
    },
    [commitFollowDecision],
  );
  const handleScrollBeginDrag = useCallback(() => setUserInteraction(true), [setUserInteraction]);
  const handleScrollEndDrag = useCallback(() => setUserInteraction(false), [setUserInteraction]);
  const handleMomentumScrollEnd = useCallback(() => setUserInteraction(false), [setUserInteraction]);
  const handleOlderEndReached = useCallback(() => onOlderEndReachedRef.current?.(), []);
  const onViewableItemsChangedRef = useRef(
    ({ viewableItems }: { viewableItems: Array<ViewToken<ItemT>>; changed: Array<ViewToken<ItemT>> }) => {
      const sorted = viewableItems
        .filter((token) => token.isViewable && token.index !== null)
        .map((token) => ({
          token,
          index: dataLengthRef.current - 1 - (token.index ?? 0),
        }))
        .sort((left, right) => left.index - right.index);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const keyFor = (entry: { token: ViewToken<ItemT>; index: number } | undefined) => {
        if (!entry) return null;
        return entry.token.key ?? keyExtractorRef.current(entry.token.item, entry.index);
      };
      const range: TranscriptVisibleRange = {
        firstIndex: first?.index ?? null,
        lastIndex: last?.index ?? null,
        firstKey: keyFor(first),
        lastKey: keyFor(last),
      };
      const signature = `${range.firstIndex}:${range.lastIndex}:${range.firstKey}:${range.lastKey}`;
      if (visibleRangeSignatureRef.current === signature) return;
      visibleRangeSignatureRef.current = signature;
      onVisibleRangeChangeRef.current?.(range);
    },
  );
  const viewabilityConfigRef = useRef({ itemVisiblePercentThreshold: 10, waitForInteraction: false });

  const emptyState = useMemo(
    () => (
      <View
        accessibilityLiveRegion="polite"
        testID={isLoading ? `${testID}-loading` : `${testID}-empty`}
        style={styles.emptyState}>
        {isLoading ? <ActivityIndicator color={palette.accent} size="small" /> : null}
        <Text style={styles.stateLabel}>{isLoading ? loadingLabel : emptyLabel}</Text>
      </View>
    ),
    [emptyLabel, isLoading, loadingLabel, testID],
  );
  const loadingFooter = useMemo(
    () => isLoading && data.length > 0 ? (
        <View accessibilityLiveRegion="polite" testID={`${testID}-loading`} style={styles.loadingFooter}>
          <ActivityIndicator color={palette.accent} size="small" />
          <Text style={styles.loadingFooterLabel}>{loadingLabel}</Text>
        </View>
      ) : null,
    [data.length, isLoading, loadingLabel, testID],
  );

  return (
    <FlatList<ItemT>
      key={transcriptKey}
      ref={listRef}
      testID={testID}
      style={style}
      contentContainerStyle={mergedContentContainerStyle}
      data={invertedData}
      inverted
      maintainVisibleContentPosition={maintainVisibleContentPosition}
      extraData={stableExtraData}
      renderItem={stableRenderItem}
      keyExtractor={stableKeyExtractor}
      ListEmptyComponent={emptyState}
      ListFooterComponent={loadingFooter}
      initialNumToRender={12}
      maxToRenderPerBatch={8}
      updateCellsBatchingPeriod={40}
      windowSize={7}
      removeClippedSubviews={false}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      scrollEventThrottle={32}
      onLayout={handleLayout}
      onScroll={handleScroll}
      onScrollBeginDrag={handleScrollBeginDrag}
      onScrollEndDrag={handleScrollEndDrag}
      onMomentumScrollEnd={handleMomentumScrollEnd}
      onEndReached={handleOlderEndReached}
      onEndReachedThreshold={0.25}
      onViewableItemsChanged={onViewableItemsChangedRef.current}
      viewabilityConfig={viewabilityConfigRef.current}
    />
  );
}

export const VirtualizedTranscript = forwardRef(VirtualizedTranscriptInner) as <ItemT>(
  props: VirtualizedTranscriptProps<ItemT> & RefAttributes<VirtualizedTranscriptHandle>,
) => ReactElement;

const maintainVisibleContentPosition = {
  minIndexForVisible: 0,
  // Only a reader already at native offset zero follows an inserted live row.
  // History readers keep their viewport, and this native adjustment never
  // competes with the explicit Latest action from farther away.
  autoscrollToTopThreshold: 1,
} as const;
const latestThreshold = 48;

function useShallowStableValue<T>(value: T): T {
  const stableRef = useRef(value);
  if (!shallowEqual(stableRef.current, value)) stableRef.current = value;
  return stableRef.current;
}

export function shallowEqual(left: unknown, right: unknown) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(right, key)
      && Object.is((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 12,
  },
  emptyState: {
    flex: 1,
    minHeight: 160,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 16,
  },
  stateLabel: {
    color: palette.textMuted,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '600',
  },
  loadingFooter: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  loadingFooterLabel: {
    color: palette.textMuted,
    fontSize: 12,
    lineHeight: 16,
  },
});
