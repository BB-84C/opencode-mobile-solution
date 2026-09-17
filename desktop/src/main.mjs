// Electron shell for opencode-cockpit.
//
// The window is a thin container: the UI inside it is the same React bundle the
// phone runs. The shell exists for the three things a web page cannot do for
// itself -- serve the bundle from a real origin, take the keys a window would
// otherwise spend on itself, and keep the renderer sandboxed.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, protocol, shell } from "electron";

import { buildKeymap, interceptedChords, resolve } from "./keymap.mjs";
import { chromeForPlatform } from "./window-chrome.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(path.dirname(here), "renderer");
const SCHEME = "cockpit";
const ORIGIN = `${SCHEME}://app`;

const MIME = new Map(Object.entries({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
}));

// Loading from file:// would give the page a null origin, which the relay's CORS
// policy cannot name and which disables the storage APIs the UI expects. A
// registered scheme behaves like a normal secure origin instead.
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

let keymap;
let leaderPending = false;

async function serveRenderer(request) {
  const url = new URL(request.url);
  const requested = decodeURIComponent(url.pathname);
  const relative = requested === "/" || requested === "" ? "index.html" : requested.replace(/^\/+/, "");
  const resolved = path.join(rendererDir, relative);

  // Everything served must stay inside the renderer directory: a crafted path
  // in a link should not be able to read the rest of the disk.
  const normalized = path.normalize(resolved);
  if (!normalized.startsWith(rendererDir + path.sep) && normalized !== rendererDir) {
    return new Response("forbidden", { status: 403 });
  }

  let body;
  try {
    body = await fs.readFile(normalized);
  } catch {
    // Expo Router owns the routes; an unknown path is a client route, not a 404.
    try {
      body = await fs.readFile(path.join(rendererDir, "index.html"));
      return new Response(body, { headers: { "content-type": MIME.get(".html") } });
    } catch {
      return new Response("renderer bundle is missing; run npm run build:renderer", { status: 500 });
    }
  }

  const type = MIME.get(path.extname(normalized).toLowerCase()) ?? "application/octet-stream";
  return new Response(body, { headers: { "content-type": type } });
}

function createWindow() {
  const chrome = chromeForPlatform(process.platform);
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#0b0b0b",
    titleBarStyle: chrome.titleBarStyle,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // A hidden title bar floats the window buttons over the page, so the strip has
  // to be reserved here rather than in the shared UI that the phone also renders.
  if (chrome.needsTitlebarInset) {
    window.webContents.on("dom-ready", () => {
      void window.webContents.insertCSS(chrome.insetCss);
    });
  }

  // A terminal owns every key; a window does not. Tab moves focus, ctrl+w
  // closes the window, ctrl+p prints. Deciding here rather than in the page
  // means the default action never runs, which is the whole point.
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;

    const outcome = resolve(keymap, input, {
      context: currentContext,
      leaderPending,
    });
    if (process.env.COCKPIT_SMOKE_OUT) {
      keyTrace.push({
        key: input.key,
        control: input.control, meta: input.meta, alt: input.alt, shift: input.shift,
        context: currentContext,
        leaderPendingBefore: leaderPending,
        action: outcome.action ?? null,
      });
    }
    leaderPending = outcome.leaderPending;

    if (outcome.action) {
      window.webContents.send("cockpit:action", {
        action: outcome.action,
        context: currentContext,
      });
    }
    if (outcome.intercept) event.preventDefault();
  });

  // Links to anywhere else belong in the user's browser, not in a window that
  // holds a session credential.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(ORIGIN)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // The desktop client opens on the machine picker rather than the host list:
  // a laptop reaches several backends on one host, and which one runs the next
  // prompt is a choice worth making before a session is on screen.
  void window.loadURL(`${ORIGIN}/devices`);

  // A build that produces a bundle and a window that renders it are different
  // claims. With COCKPIT_SMOKE_OUT set the shell proves the second one: it
  // captures what the window actually painted and what the page actually says,
  // then exits non-zero if either is empty.
  if (process.env.COCKPIT_SMOKE_OUT) void runSmoke(window, process.env.COCKPIT_SMOKE_OUT);

  return window;
}

// What sendInputEvent calls the modifier keys, keyed by how a binding spells it.
const MODIFIER_NAMES = { ctrl: "control", control: "control", cmd: "meta", command: "meta", meta: "meta", alt: "alt", option: "alt", shift: "shift" };
const KNOWN_MODIFIERS = new Set(["control", "meta", "alt", "shift"]);

async function runSmoke(window, outputDir) {
  const failures = [];
  try {
    await new Promise((done, fail) => {
      window.webContents.once("did-finish-load", done);
      window.webContents.once("did-fail-load", (_e, code, description) => fail(new Error(`${code} ${description}`)));
      setTimeout(() => fail(new Error("the page did not finish loading within 30s")), 30_000);
    });
    await new Promise((done) => setTimeout(done, 1_500));

    await fs.mkdir(outputDir, { recursive: true });
    const image = await window.webContents.capturePage();
    await fs.writeFile(path.join(outputDir, "window.png"), image.toPNG());

    const text = await window.webContents.executeJavaScript("document.body.innerText");
    await fs.writeFile(path.join(outputDir, "body.txt"), text ?? "");

    // The traffic lights float over the page on macOS, so the app's first row has
    // to start below them. Measure where the topmost visible text actually
    // landed. A computed padding only proves the CSS parsed; a root element that
    // fills the window by absolute positioning ignores it, and the header still
    // renders under the buttons.
    const geometry = await window.webContents.executeJavaScript(`(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let top = Infinity, sample = "";
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.top < top) { top = rect.top; sample = node.nodeValue.trim().slice(0, 40); }
      }
      const roots = Array.from(document.body.children).map((el) => {
        const s = getComputedStyle(el);
        return { tag: el.tagName, id: el.id, position: s.position, top: s.top, height: s.height };
      });
      return { textTop: Number.isFinite(top) ? top : null, sample,
               bodyPaddingTop: getComputedStyle(document.body).paddingTop, roots };
    })()`);
    await fs.writeFile(path.join(outputDir, "chrome-geometry.json"), JSON.stringify(geometry, null, 2));
    process.stdout.write(`smoke: topmost text "${geometry.sample}" at y=${geometry.textTop} (body padding ${geometry.bodyPaddingTop})\n`);
    process.stdout.write(`smoke: body children ${JSON.stringify(geometry.roots)}\n`);
    if (geometry.textTop === null) {
      failures.push("the page rendered no visible text");
    } else if (process.platform === "darwin") {
      // The buttons float over the page, so the first row has to clear them.
      if (geometry.textTop < 20) {
        failures.push(`content sits under the traffic lights (topmost text at y=${geometry.textTop})`);
      }
    } else if (geometry.textTop >= 20) {
      // Everywhere else the OS draws a real title bar above the page. Reserving
      // the strip anyway is the same bug mirrored: a band of dead margin at the
      // top of every window, which nothing would otherwise report.
      failures.push(
        `content starts at y=${geometry.textTop} on ${process.platform}, which means the macOS titlebar inset leaked onto a platform with a real title bar`,
      );
    }

    // First paint is not the finished screen. Anything that needs the network —
    // the machine list, the session list — is still in flight at this point, and
    // judging the app by the earlier capture reports a spinner as a failure.
    await new Promise((done) => setTimeout(done, 8_000));
    const settled = await window.webContents.executeJavaScript("document.body.innerText");
    await fs.writeFile(path.join(outputDir, "body-settled.txt"), settled ?? "");
    process.stdout.write(`smoke: settled text ${JSON.stringify((settled ?? "").slice(0, 160))}\n`);

    // Ask the renderer itself to reach the relay. Doing it from a shell proves
    // the server answers; doing it from here proves the app's own origin, TLS
    // trust and proxy settings let it through, which is the half a curl cannot
    // separate when the window shows an empty list.
    if (process.env.COCKPIT_SMOKE_FETCH) {
      const headers = process.env.COCKPIT_SMOKE_FETCH_TOKEN
        ? { Authorization: `Bearer ${process.env.COCKPIT_SMOKE_FETCH_TOKEN}` }
        : {};
      const reach = await window.webContents.executeJavaScript(
        `fetch(${JSON.stringify(process.env.COCKPIT_SMOKE_FETCH)}, { headers: ${JSON.stringify(headers)} })
           .then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 120) }))
           .catch((e) => ({ status: "threw", body: String(e) }))`,
      );
      process.stdout.write(`smoke: renderer fetch -> ${reach.status} ${JSON.stringify(reach.body)}\n`);
    }

    const errors = await window.webContents.executeJavaScript("window.__cockpitProbe ? window.__cockpitProbe.errors() : []");
    await fs.writeFile(path.join(outputDir, "console-errors.json"), JSON.stringify(errors, null, 2));

    // Press a key for real and look for its consequence in the page. Anything
    // less proves the shell resolved a binding, not that the app acted on it:
    // the chain from keymap through IPC, routing and the store is only tested
    // by something the user could have seen.
    // Some screens can only be reached by pointer, so a keyboard smoke needs a
    // way in before it can press anything meaningful.
    if (process.env.COCKPIT_SMOKE_CLICK) {
      const clicked = await window.webContents.executeJavaScript(
        `(() => {
           const el = document.querySelector(${JSON.stringify(process.env.COCKPIT_SMOKE_CLICK)});
           if (!el) return false;
           el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
           el.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
           el.click();
           return true;
         })()`,
      );
      process.stdout.write(`smoke: clicked ${process.env.COCKPIT_SMOKE_CLICK} -> ${clicked}\n`);
      if (!clicked) failures.push(`nothing matched ${process.env.COCKPIT_SMOKE_CLICK}`);
      await new Promise((done) => setTimeout(done, 3_000));
      const afterClick = await window.webContents.executeJavaScript("document.body.innerText");
      await fs.writeFile(path.join(outputDir, "body-after-click.txt"), afterClick ?? "");
      process.stdout.write(`smoke: after click "${(afterClick ?? "").split("\n")[0]}"\n`);
    }

    if (process.env.COCKPIT_SMOKE_KEY) {
      window.webContents.focus();
      // A comma separates chords in a sequence, so a leader binding such as
      // "ctrl+x,n" can be exercised the way a user actually types it.
      for (const chord of process.env.COCKPIT_SMOKE_KEY.split(",")) {
        const [key, ...rest] = chord.trim().split("+").reverse();
        // sendInputEvent names modifiers its own way and silently ignores a name
        // it does not know. "ctrl" is such a name: the modifier vanished, the
        // press landed as a bare letter, and a smoke that pressed nothing of the
        // sort still reported the screen had changed.
        const modifiers = rest.map((name) => MODIFIER_NAMES[name.toLowerCase()] ?? name.toLowerCase());
        const unknown = modifiers.filter((name) => !KNOWN_MODIFIERS.has(name));
        if (unknown.length > 0) failures.push(`unknown modifier(s) in "${chord}": ${unknown.join(", ")}`);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
        await new Promise((done) => setTimeout(done, 250));
      }
      await new Promise((done) => setTimeout(done, 1_200));

      // Which actions the shell actually delivered to the page. Without this,
      // "the key never resolved" and "it resolved and nothing handled it" look
      // identical from the outside, and they need opposite fixes.
      await fs.writeFile(path.join(outputDir, "key-trace.json"), JSON.stringify(keyTrace, null, 2));
      process.stdout.write(`smoke: shell saw ${keyTrace.length} keydown(s): ${JSON.stringify(keyTrace.map((k) => `${k.control ? "ctrl+" : ""}${k.key}->${k.action ?? "none"}`))}\n`);

      const delivered = await window.webContents.executeJavaScript("window.__cockpitProbe ? window.__cockpitProbe.actions() : []");
      await fs.writeFile(path.join(outputDir, "delivered-actions.json"), JSON.stringify(delivered, null, 2));
      process.stdout.write(`smoke: shell delivered ${JSON.stringify(delivered)}\n`);

      if (process.env.COCKPIT_SMOKE_EVAL) {
        const value = await window.webContents.executeJavaScript(
          `(() => { try { return JSON.stringify(${process.env.COCKPIT_SMOKE_EVAL}); } catch (e) { return "threw: " + String(e); } })()`,
        );
        process.stdout.write(`smoke: eval -> ${value}\n`);
      }

      const afterKey = await window.webContents.executeJavaScript("document.body.innerText");
      await fs.writeFile(path.join(outputDir, "body-after-key.txt"), afterKey ?? "");
      process.stdout.write(`smoke: pressed ${process.env.COCKPIT_SMOKE_KEY}\n`);

      if ((afterKey ?? "") === (text ?? "")) {
        failures.push(`pressing ${process.env.COCKPIT_SMOKE_KEY} changed nothing on screen`);
      }
    }

    if (image.isEmpty()) failures.push("the window painted nothing");
    if (!text || text.trim().length === 0) failures.push("the page rendered no text");
    if (errors.length > 0) failures.push(`${errors.length} console error(s)`);

    process.stdout.write(`smoke: ${failures.length === 0 ? "ok" : failures.join("; ")}\n`);
    process.stdout.write(`smoke: first line of page text: ${(text ?? "").split("\n")[0]}\n`);
  } catch (error) {
    failures.push(error.message);
    process.stdout.write(`smoke: ${error.message}\n`);
  }
  app.exit(failures.length === 0 ? 0 : 1);
}

const keyTrace = [];
let currentContext = "global";

ipcMain.on("cockpit:context", (_event, context) => {
  if (typeof context === "string" && context.length > 0) currentContext = context;
});

ipcMain.handle("cockpit:describe-keymap", () => ({
  platform: keymap.platform,
  leader: keymap.leader.id,
  conflicts: keymap.conflicts,
  bindings: keymap.bindings.map((binding) => ({
    action: binding.action,
    description: binding.description,
    context: binding.context,
    chord: binding.sequence.map((chord) => chord.id).join(" "),
  })),
}));

app.whenReady().then(async () => {
  const definitions = JSON.parse(
    await fs.readFile(path.join(here, "keybinds", "opencode-1.18.18.json"), "utf8"),
  );
  keymap = buildKeymap({ definitions, platform: process.platform });

  protocol.handle(SCHEME, serveRenderer);
  createWindow();

  process.stdout.write(
    `cockpit: leader ${keymap.leader.id}, ${keymap.bindings.length} bindings, ` +
    `${interceptedChords(keymap).length} chords claimed, ${keymap.conflicts.length} conflict(s)\n`,
  );

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
