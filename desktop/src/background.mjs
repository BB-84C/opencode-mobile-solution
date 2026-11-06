// Decisions behind the shell's resident mode, kept free of Electron so they can
// be tested: the shell stays alive in the tray after its window closes so it
// can keep watching hosts, and every path back to the window has to work, or a
// notification would announce something the user cannot then open.

import fs from "node:fs";
import path from "node:path";

export const HIDDEN_FLAG = "--hidden";

/** A notification may only lead to a session screen inside the app. Anything
 *  else from the page is dropped rather than navigated to. */
export function notificationRoute(route) {
  if (typeof route !== "string") return null;
  return /^\/session\/[0-9a-f]+$/.test(route) ? route : null;
}

/** Started by the login item, the shell should sit in the tray instead of
 *  putting a window in front of the user at boot. */
export function launchedHidden({ argv = [], platform = process.platform, loginItem = {} } = {}) {
  if (argv.includes(HIDDEN_FLAG)) return true;
  return platform === "darwin" && loginItem.wasOpenedAtLogin === true;
}

export function loginItemOptions(platform, enabled) {
  if (platform === "darwin") return { openAtLogin: enabled, openAsHidden: true };
  return { openAtLogin: enabled, args: [HIDDEN_FLAG] };
}

const DEFAULT_SETTINGS = { openAtLogin: true };

/** Settings live next to the profile. A missing or unreadable file means the
 *  defaults, which is also what a first run gets: resident and auto-started. */
export function readSettings(directory) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, "cockpit-settings.json"), "utf8"));
    return {
      ...DEFAULT_SETTINGS,
      ...(typeof parsed.openAtLogin === "boolean" ? { openAtLogin: parsed.openAtLogin } : {}),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(directory, settings) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "cockpit-settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

/** The right-click menu, as Electron menu item templates. Built from what the
 *  page reports about the click, so Copy appears whenever text is selected and
 *  Paste only where it can land. */
export function contextMenuItems(params = {}) {
  const flags = params.editFlags ?? {};
  const hasSelection = typeof params.selectionText === "string" && params.selectionText.length > 0;
  const items = [];
  if (params.isEditable) items.push({ role: "cut", enabled: Boolean(flags.canCut) });
  if (params.isEditable || hasSelection) items.push({ role: "copy", enabled: hasSelection || Boolean(flags.canCopy) });
  if (params.isEditable) items.push({ role: "paste", enabled: flags.canPaste !== false });
  if (items.length > 0) items.push({ type: "separator" });
  items.push({ role: "selectAll" });
  return items;
}

export function notificationPayload(value) {
  if (!value || typeof value !== "object") return null;
  const title = typeof value.title === "string" ? value.title.slice(0, 120) : "";
  const body = typeof value.body === "string" ? value.body.slice(0, 400) : "";
  if (!title) return null;
  return { title, body, route: notificationRoute(value.route) };
}

/** Windows identifies an app's notifications by this id. It matches the macOS
 *  bundle id so both platforms name the app the same way. */
export const APP_USER_MODEL_ID = "dev.opencode.cockpit";
// Fixed rather than generated per run: the shortcut written on one launch has
// to name the same activator on every later launch.
export const TOAST_ACTIVATOR_CLSID = "{5cf9b771-6d91-4c98-a96a-3fe838711cfb}";

/** Windows shows a toast only for an app that has a Start Menu shortcut with
 *  its AppUserModelID. An installer would create one; this build is a plain
 *  folder, so the app writes its own. */
export function windowsStartMenuShortcut({ appData, execPath }) {
  return {
    path: path.win32.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "OpenCode Cockpit.lnk"),
    details: {
      target: execPath,
      description: "OpenCode Cockpit",
      appUserModelId: APP_USER_MODEL_ID,
      toastActivatorClsid: TOAST_ACTIVATOR_CLSID,
    },
  };
}
