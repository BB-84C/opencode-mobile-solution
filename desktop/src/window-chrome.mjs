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
    insetCss: framelessTitleBar
      ? `body{padding-top:env(titlebar-area-height,${TITLEBAR_INSET_PX}px)!important;box-sizing:border-box}`
      : null,
  };
}
