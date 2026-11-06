import { useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { palette } from '@/src/ui/palette';
import { writeClipboardText } from '@/src/ux/clipboard';

import { MathHtmlView } from './MathHtmlView';
import { SelectableBlock } from './SelectableBlock';

export function TextViewModal({
  title,
  text,
  visible,
  wordWrap = true,
  prose = false,
  focusOffset = 0,
  html,
  onClose,
}: {
  title: string;
  text: string;
  visible: boolean;
  wordWrap?: boolean;
  /** Body font instead of monospace, for a conversation rather than output. */
  prose?: boolean;
  /** Character offset to open the sheet at, e.g. the message it was opened from. */
  focusOffset?: number;
  /** The same content as HTML with typeset math. Used on iOS, the only place a WebView is needed to show formulas. */
  html?: string;
  onClose(): void;
}) {
  const [copyError, setCopyError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const { height: windowHeight } = useWindowDimensions();
  const showHtml = Boolean(html) && Platform.OS === 'ios';
  const textStyle = [prose ? styles.prose : styles.mono, wordWrap && styles.wordWrap];
  return (
    <Modal
      animationType="slide"
      transparent
      presentationStyle="overFullScreen"
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
      visible={visible}
      onRequestClose={onClose}>
      <Pressable testID="text-view-scrim" style={styles.scrim} onPress={onClose}>
        <Pressable testID="text-view-sheet" style={styles.sheet} onPress={(event) => event.stopPropagation()}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable
              accessibilityRole="button"
              testID="text-view-copy-raw"
              style={styles.copyButton}
              onPress={async () => {
                setCopyError(null);
                try {
                  await writeClipboardText(text);
                } catch (error) {
                  setCopyError(error instanceof Error ? error.message : String(error));
                }
              }}>
              <Text style={styles.copyButtonText}>Copy raw</Text>
            </Pressable>
          </View>
          {copyError ? <Text selectable testID="text-view-copy-error" style={styles.error}>{copyError}</Text> : null}
          {showHtml ? (
            <View testID="text-view-html" style={[styles.textFrame, { height: windowHeight * 0.7 }]}>
              <MathHtmlView bodyHtml={html ?? ''} scrollable />
            </View>
          ) : (
          <ScrollView ref={scrollRef} testID="text-view-scroll" style={styles.textFrame} contentContainerStyle={styles.textContent}>
            {focusOffset > 0 ? (
              // The text before the focus point, laid out invisibly at the same
              // width: its height is how far down the focused message starts.
              <Text
                testID="text-view-focus-measure"
                accessible={false}
                style={[textStyle, styles.measure]}
                onLayout={(event) => scrollRef.current?.scrollTo({ y: event.nativeEvent.layout.height, animated: false })}>
                {text.slice(0, focusOffset)}
              </Text>
            ) : null}
            <SelectableBlock testID="text-view-content" style={textStyle} text={text || 'No text content'} />
          </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: palette.scrim,
  },
  sheet: {
    maxHeight: '86%',
    gap: 10,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 30,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    backgroundColor: palette.panel,
  },
  handle: {
    alignSelf: 'center',
    width: 42,
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.borderActive,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: palette.text,
  },
  copyButton: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: palette.primary,
  },
  copyButtonText: {
    fontWeight: '800',
    color: palette.foregroundOnAccent,
  },
  error: {
    color: palette.error,
  },
  textFrame: {
    flexShrink: 1,
    borderWidth: 1,
    borderColor: palette.borderSubtle,
    borderRadius: 8,
    backgroundColor: palette.codeBg,
  },
  textContent: {
    padding: 12,
  },
  mono: {
    fontFamily: 'SpaceMono',
    fontSize: 12,
    lineHeight: 18,
    color: palette.code,
  },
  prose: {
    fontSize: 14,
    lineHeight: 20,
    color: palette.text,
  },
  measure: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    opacity: 0,
  },
  wordWrap: {
    flexShrink: 1,
    flexWrap: 'wrap',
  },
});
