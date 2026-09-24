import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chromeForPlatform, TITLEBAR_INSET_PX } from '../src/window-chrome.mjs';

const PLATFORMS = ['darwin', 'win32', 'linux'];

test('macOS hides the title bar and therefore has to reserve a strip for the window buttons', () => {
  const chrome = chromeForPlatform('darwin');

  assert.equal(chrome.titleBarStyle, 'hiddenInset');
  assert.equal(chrome.needsTitlebarInset, true);
  assert.match(chrome.insetCss, /translateY/);
});

test('elsewhere the OS draws a real title bar, so reserving that strip would be dead margin', () => {
  for (const platform of ['win32', 'linux']) {
    const chrome = chromeForPlatform(platform);

    assert.equal(chrome.titleBarStyle, 'default', `${platform} should keep the system title bar`);
    assert.equal(chrome.needsTitlebarInset, false, `${platform} should not reserve a strip`);
    assert.equal(chrome.insetCss, null, `${platform} should have nothing to inject`);
  }
});

test('a frameless title bar always comes with its inset, on every platform', () => {
  // This pairing is the whole point: shipping the hidden title bar without the
  // inset is what put the window buttons on top of the app header, and the two
  // decisions used to live far enough apart that one could change alone.
  for (const platform of PLATFORMS) {
    const chrome = chromeForPlatform(platform);
    const frameless = chrome.titleBarStyle === 'hiddenInset';

    assert.equal(
      chrome.needsTitlebarInset,
      frameless,
      `${platform}: inset must be needed exactly when the title bar is hidden`,
    );
    assert.equal(
      chrome.insetCss !== null,
      frameless,
      `${platform}: CSS must be supplied exactly when the inset is needed`,
    );
  }
});

test('the inset moves fixed overlays too, not just the document flow', () => {
  // Padding left every dialog under the window buttons: a fixed element is
  // positioned against the viewport and ignores an ancestor's padding.
  const css = chromeForPlatform('darwin').insetCss;

  assert.match(css, /transform:translateY/, 'must transform, so body becomes the containing block');
  assert.match(css, /height:calc\(100vh - \d+px\)/, 'must trim the height by the same amount');
  assert.ok(!/padding-top/.test(css), 'padding alone is what left dialogs overlapping');
});

test('reserves enough room for the buttons to sit clear of the content', () => {
  // macOS traffic lights occupy roughly 20px; below that they still overlap.
  assert.ok(TITLEBAR_INSET_PX >= 20, `${TITLEBAR_INSET_PX}px is not enough room`);
  assert.match(chromeForPlatform('darwin').insetCss, new RegExp(`${TITLEBAR_INSET_PX}px`));
});

test('an unknown platform is treated like the ones with a real title bar', () => {
  // Better a visible system title bar than window buttons over the content on a
  // platform nobody checked.
  const chrome = chromeForPlatform('freebsd');

  assert.equal(chrome.titleBarStyle, 'default');
  assert.equal(chrome.needsTitlebarInset, false);
});
