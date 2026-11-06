/**
 * Only iOS renders math through a WebView (MathHtmlView.ios.tsx). The web and
 * desktop build typeset it inline with KaTeX instead, so nothing calls this.
 */
export function MathHtmlView(_props: {
  bodyHtml: string;
  muted?: boolean;
  scrollable?: boolean;
  estimatedHeight?: number;
  testID?: string;
}) {
  return null;
}
