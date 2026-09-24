// The only bridge between the shell and the page.
//
// A sandboxed preload must be CommonJS. Everything crossing this boundary is
// named explicitly: the renderer gets three functions, not a channel it can
// send anything down, so a compromised page cannot reach the rest of Electron.

const { contextBridge, ipcRenderer } = require("electron");

// Collected so a smoke run can assert on them. Without this the check would read
// an array nothing ever writes to, which is a test that cannot fail.
const pageErrors = [];
window.addEventListener("error", (event) => {
  pageErrors.push(String(event.message ?? event.error ?? "unknown error"));
});
window.addEventListener("unhandledrejection", (event) => {
  pageErrors.push(`unhandled rejection: ${String(event.reason)}`);
});


// Every action the shell delivers, in order. Collected for the same reason as
// the errors above: a smoke run has to tell "the key never arrived" apart from
// "it arrived and nothing downstream handled it", and those two have identical
// symptoms on screen.
const deliveredActions = [];
// Recorded here rather than inside onAction: this has to answer "did the shell
// send it", which stays true even when the page never subscribed. Hanging it off
// the app's own listener would conflate the two and report a delivered action as
// missing.
ipcRenderer.on("cockpit:action", (_event, payload) => {
  deliveredActions.push(payload?.action ?? String(payload));
});
// Exposed as functions, not as the arrays themselves. contextBridge deep-clones
// a value it copies across, so an array handed over directly is a dead snapshot:
// every later push lands in this world and is invisible in the page's. A smoke
// reading that copy sees an empty list no matter what happened, which is how a
// console-error check passed for weeks without ever being able to fail.
contextBridge.exposeInMainWorld("__cockpitProbe", {
  actions: () => deliveredActions.slice(),
  errors: () => pageErrors.slice(),
});

const VALID_CONTEXTS = new Set([
  "global",
  "input",
  "messages",
  "diff",
  "which_key",
  "dialog:select",
  "dialog:prompt",
  "dialog:mcp",
  "dialog:model",
  "dialog:stash",
  "dialog:move_session",
  "dialog:plugins",
  "dialog:autocomplete",
  "dialog:permission",
]);

contextBridge.exposeInMainWorld("cockpit", {
  /** Tells the shell which surface has focus, so the same key can mean
   *  different things in a dialog and in the prompt. */
  setContext(context) {
    if (!VALID_CONTEXTS.has(context)) {
      throw new Error(`unknown context: ${context}`);
    }
    ipcRenderer.send("cockpit:context", context);
  },

  /** Called when a key the shell claimed resolves to an opencode action. */
  onAction(handler) {
    if (typeof handler !== "function") throw new TypeError("onAction needs a function");
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("cockpit:action", listener);
    return () => ipcRenderer.removeListener("cockpit:action", listener);
  },

  /** The resolved keymap, for a help screen and for showing which bindings
   *  collide on this platform. */
  describeKeymap() {
    return ipcRenderer.invoke("cockpit:describe-keymap");
  },
});
