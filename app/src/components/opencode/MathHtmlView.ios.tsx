import { useMemo, useState } from 'react';
import { Linking, StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { palette } from '@/src/ui/palette';

import { KATEX_CSS } from './katex-inline-css.generated';
import { mathDocument } from './math-html';

/**
 * HTML with typeset math, in a WebView (iOS).
 *
 * Inline use sizes the view to its content from heights the page reports, and
 * leaves vertical scrolling to the transcript. `scrollable` fills its frame and
 * scrolls itself, opening at the element with id "focus".
 */
export function MathHtmlView({
  bodyHtml,
  muted = false,
  scrollable = false,
  estimatedHeight = 40,
  testID,
}: {
  bodyHtml: string;
  muted?: boolean;
  scrollable?: boolean;
  estimatedHeight?: number;
  testID?: string;
}) {
  const [height, setHeight] = useState(estimatedHeight);
  const html = useMemo(
    () =>
      mathDocument({
        bodyHtml,
        katexCss: KATEX_CSS,
        scrollable,
        colors: {
          text: muted ? palette.textMuted : palette.text,
          muted: palette.textMuted,
          primary: palette.primary,
          warning: palette.warning,
          codeBackground: palette.backgroundElement,
          border: palette.borderSubtle,
        },
      }),
    [bodyHtml, muted, scrollable],
  );

  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const reported = Number(JSON.parse(event.nativeEvent.data).height);
      if (Number.isFinite(reported) && reported > 0) setHeight(reported);
    } catch {
      // Only this page posts messages, and only heights; anything else is noise.
    }
  };

  return (
    <WebView
      testID={testID}
      originWhitelist={['*']}
      source={{ html }}
      style={[styles.web, scrollable ? styles.fill : { height }]}
      scrollEnabled={scrollable}
      bounces={scrollable}
      showsVerticalScrollIndicator={scrollable}
      showsHorizontalScrollIndicator={false}
      dataDetectorTypes="none"
      onMessage={scrollable ? undefined : onMessage}
      onShouldStartLoadWithRequest={(request) => {
        // The document itself loads as about:blank; a tapped link opens outside.
        if (request.navigationType !== 'click') return true;
        Linking.openURL(request.url).catch((error: unknown) => console.warn(`could not open ${request.url}: ${String(error)}`));
        return false;
      }}
    />
  );
}

const styles = StyleSheet.create({
  web: { backgroundColor: 'transparent' },
  fill: { flex: 1 },
});
