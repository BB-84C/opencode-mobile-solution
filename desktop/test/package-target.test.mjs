import assert from 'node:assert/strict';
import { test } from 'node:test';

import { packageTargetFor } from '../scripts/package-target.mjs';

const APP = 'OpenCode Cockpit';

test('a macOS build is a .app bundle whose executable hides inside Contents/MacOS', () => {
  const target = packageTargetFor('darwin', 'arm64', APP);

  assert.equal(target.directory, `${APP}-darwin-arm64`);
  assert.ok(target.artifact.endsWith('.app'), `${target.artifact} is not a bundle`);
  assert.ok(target.executable.includes('Contents/MacOS'), target.executable);
  assert.ok(target.propertyList?.endsWith('Info.plist'), 'macOS builds carry an Info.plist');
  assert.equal(target.icon, 'icon.icns');
});

test('a Windows build is a plain directory with an .exe and no property list', () => {
  const target = packageTargetFor('win32', 'x64', APP);

  assert.equal(target.directory, `${APP}-win32-x64`);
  assert.equal(target.artifact, `${APP}-win32-x64`);
  assert.ok(target.executable.endsWith(`${APP}.exe`), target.executable);
  // Linting a plist that cannot exist would fail every Windows build, and the
  // tool that lints it only exists on macOS anyway.
  assert.equal(target.propertyList, null);
  // Windows cannot read an .icns, and shipping one leaves the default Electron
  // icon on the taskbar with no error anywhere.
  assert.equal(target.icon, 'icon.ico');
});

test('every supported platform names an executable the build script can check for', () => {
  // The script proves the artefact exists rather than trusting the packager's
  // exit code, which it can only do if the target says where to look.
  for (const platform of ['darwin', 'win32']) {
    const target = packageTargetFor(platform, 'x64', APP);

    assert.ok(target.executable.length > 0, `${platform} named no executable`);
    assert.ok(
      target.executable.startsWith(target.directory),
      `${platform}: the executable must sit inside the output directory`,
    );
    assert.ok(target.firstLaunchNote.length > 0, `${platform} should warn about being unsigned`);
    assert.ok(target.icon.length > 0, `${platform} named no icon`);
  }
});

test('the two platforms ask for different icon containers from one source image', () => {
  // The icon is the friend's artwork, kept as a single 1024px source; the build
  // derives both containers so macOS and Windows cannot drift apart.
  const icons = ['darwin', 'win32'].map((p) => packageTargetFor(p, 'x64', APP).icon);

  assert.deepEqual(icons, ['icon.icns', 'icon.ico']);
  assert.equal(new Set(icons).size, icons.length, 'each platform needs its own container');
});

test('an unrecognised architecture falls back rather than reaching the packager as a typo', () => {
  assert.equal(packageTargetFor('win32', 'ia32', APP).arch, 'arm64');
  assert.equal(packageTargetFor('darwin', 'x64', APP).arch, 'x64');
});

test('a platform this project does not ship fails loudly instead of building nothing', () => {
  assert.throws(() => packageTargetFor('linux', 'x64', APP), /unsupported package platform linux/);
});
