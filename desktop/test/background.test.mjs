import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  APP_USER_MODEL_ID,
  HIDDEN_FLAG,
  TOAST_ACTIVATOR_CLSID,
  windowsStartMenuShortcut,
  contextMenuItems,
  launchedHidden,
  loginItemOptions,
  notificationPayload,
  notificationRoute,
  readSettings,
  writeSettings,
} from '../src/background.mjs';

test('a notification can only lead to a session screen', () => {
  assert.equal(notificationRoute('/session/5b2239'), '/session/5b2239');
  assert.equal(notificationRoute('https://evil.example'), null);
  assert.equal(notificationRoute('/session/../modal'), null);
  assert.equal(notificationRoute('/devices'), null);
  assert.equal(notificationRoute(undefined), null);
});

test('a notification without a title is not shown, and long text is cut', () => {
  assert.equal(notificationPayload({ body: 'x' }), null);
  const payload = notificationPayload({ title: 'T', body: 'b'.repeat(1000), route: '/session/ab' });
  assert.equal(payload.body.length, 400);
  assert.equal(payload.route, '/session/ab');
  assert.equal(notificationPayload({ title: 'T', route: 'javascript:alert(1)' }).route, null);
});

test('starts hidden only when the login item started it', () => {
  assert.equal(launchedHidden({ argv: ['electron', HIDDEN_FLAG], platform: 'win32' }), true);
  assert.equal(launchedHidden({ argv: ['electron'], platform: 'win32' }), false);
  assert.equal(launchedHidden({ argv: [], platform: 'darwin', loginItem: { wasOpenedAtLogin: true } }), true);
  assert.equal(launchedHidden({ argv: [], platform: 'darwin', loginItem: { wasOpenedAtLogin: false } }), false);
});

test('the login item tells each platform to start in the tray', () => {
  assert.deepEqual(loginItemOptions('win32', true), { openAtLogin: true, args: [HIDDEN_FLAG] });
  assert.deepEqual(loginItemOptions('darwin', false), { openAtLogin: false, openAsHidden: true });
});

test('auto-start defaults to on, and a stored choice wins', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-settings-'));
  try {
    assert.deepEqual(readSettings(directory), { openAtLogin: true });
    writeSettings(directory, { openAtLogin: false });
    assert.deepEqual(readSettings(directory), { openAtLogin: false });
    fs.writeFileSync(path.join(directory, 'cockpit-settings.json'), '{broken');
    assert.deepEqual(readSettings(directory), { openAtLogin: true });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the right-click menu offers Copy whenever text is selected', () => {
  const onText = contextMenuItems({ selectionText: 'hello', isEditable: false, editFlags: {} });
  assert.deepEqual(onText.map((item) => item.role ?? item.type), ['copy', 'separator', 'selectAll']);
  assert.equal(onText[0].enabled, true);

  const inInput = contextMenuItems({ selectionText: '', isEditable: true, editFlags: { canCut: false, canPaste: true } });
  assert.deepEqual(inInput.map((item) => item.role ?? item.type), ['cut', 'copy', 'paste', 'separator', 'selectAll']);

  const nothing = contextMenuItems({ selectionText: '', isEditable: false });
  assert.deepEqual(nothing.map((item) => item.role), ['selectAll']);
});

test('the Windows Start Menu shortcut carries the ids a toast needs', () => {
  // Without a Start Menu shortcut that names the same AppUserModelID and toast
  // activator, Windows drops every notification from an app with no installer.
  const shortcut = windowsStartMenuShortcut({
    appData: 'C:\\Users\\me\\AppData\\Roaming',
    execPath: 'D:\\Apps\\OpenCode Cockpit\\OpenCode Cockpit.exe',
  });
  assert.equal(shortcut.path, 'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\OpenCode Cockpit.lnk');
  assert.equal(shortcut.details.target, 'D:\\Apps\\OpenCode Cockpit\\OpenCode Cockpit.exe');
  assert.equal(shortcut.details.appUserModelId, APP_USER_MODEL_ID);
  assert.equal(shortcut.details.toastActivatorClsid, TOAST_ACTIVATOR_CLSID);
  assert.match(TOAST_ACTIVATOR_CLSID, /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i);
});
