/**
 * What the window frame looks like, per platform.
 *
 * macOS gets a hidden inset title bar, which floats the window buttons over the
 * page; the page then has to reserve a strip for them or its first row renders
 * underneath. Everywhere else the OS draws a real title bar above the content,
 * so reserving that strip would be dead margin.
 *
 * Kept apart from the window code so the pairing of the two decisions can be
 * asserted: a title bar style without its matching inset is the bug this
 * module exists to prevent.
 */

export const TITLEBAR_INSET_PX = 28;

export function chromeForPlatform(platform) {
  const framelessTitleBar = platform === "darwin";
  return {
    titleBarStyle: framelessTitleBar ? "hiddenInset" : "default",
    needsTitlebarInset: framelessTitleBar,
    // A transform rather than padding. Padding moves the document flow and
    // leaves fixed overlays where they were, so every dialog still rendered
    // under the window buttons. Transforming body makes it the containing block
    // for its fixed descendants, and the height is trimmed by the same amount so
    // nothing falls off the bottom.
    insetCss: framelessTitleBar
      ? `body{transform:translateY(${TITLEBAR_INSET_PX}px)!important;height:calc(100vh - ${TITLEBAR_INSET_PX}px)!important;box-sizing:border-box}`
      : null,
  };
}
