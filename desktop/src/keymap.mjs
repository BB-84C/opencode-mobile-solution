// Turns opencode's TUI keybinding table into something a windowed app can use.
//
// The table itself is vendored from the binary that the host runs, so it matches
// the version actually serving sessions rather than the latest documentation.
// Three things have to be added on top of it:
//
//   1. A leader key. `<leader>n` means press the leader chord, release it, then
//      press n. The default leader is ctrl+x, which in a text field is Cut, so
//      the shell has to claim it before the field sees it.
//   2. Platform mapping. The table says `super`, which is Command on macOS and
//      has no good equivalent elsewhere, so it becomes Control.
//   3. Interception. A terminal owns every key; a window does not. Tab moves
//      focus, ctrl+w closes the window, ctrl+p prints. Each of those has to be
//      taken before the default action runs, or the binding is decorative.

export const MODIFIERS = ["ctrl", "shift", "alt", "meta"];

// Chords a window or its host would otherwise consume. Intercepting is not
// cosmetic: without it ctrl+w closes the window mid-session and tab silently
// moves focus out of the prompt.
const MUST_INTERCEPT = new Set([
  "ctrl+x", "ctrl+c", "ctrl+a", "ctrl+p", "ctrl+n", "ctrl+w", "ctrl+t",
  "ctrl+f", "ctrl+d", "ctrl+k", "ctrl+u", "ctrl+z", "ctrl+r",
  "tab", "shift+tab", "escape",
  "meta+a", "meta+z", "meta+shift+z",
]);

// Paste is the one binding opencode itself marks as non-preventing: the table
// stores it as an object with preventDefault false. Claiming it would break the
// platform's own clipboard handling for no gain.
const NEVER_INTERCEPT = new Set(["ctrl+v", "meta+v"]);

// Only one dialog is ever open, so each gets its own context. Without that
// split every dialog's Enter and arrow keys collide with every other one's.
const CONTEXT_BY_PREFIX = [
  ["dialog.select.", "dialog:select"],
  ["dialog.prompt.", "dialog:prompt"],
  ["dialog.mcp.", "dialog:mcp"],
  ["dialog.move_session.", "dialog:move_session"],
  ["dialog.plugins.", "dialog:plugins"],
  ["plugins.", "dialog:plugins"],
  ["prompt.autocomplete", "dialog:autocomplete"],
  ["permission.", "dialog:permission"],
  ["which_key_", "which_key"],
  ["diff_", "diff"],
  ["input_", "input"],
  ["history_", "input"],
  ["messages_", "messages"],
];

// Actions that open a surface share that surface's prefix but must be reachable
// from outside it: diff_open belongs to whatever screen the user is on, not to
// the viewer it has yet to open.
const GLOBAL_ENTRY_POINTS = new Set(["diff_open"]);

// A handful of actions are scoped to a list in the TUI but carry no prefix that
// says so, and they collide on ctrl+d and ctrl+f with global bindings. The name
// cannot tell us, so the mapping is stated.
const CONTEXT_BY_ACTION = new Map([
  ["session_delete", "dialog:select"],
  ["session_pin_toggle", "dialog:select"],
  ["session_rename", "dialog:select"],
  ["stash_delete", "dialog:stash"],
  ["model_favorite_toggle", "dialog:model"],
  ["model_provider_list", "dialog:model"],
]);

export function contextFor(action) {
  if (GLOBAL_ENTRY_POINTS.has(action)) return "global";
  if (CONTEXT_BY_ACTION.has(action)) return CONTEXT_BY_ACTION.get(action);
  for (const [prefix, context] of CONTEXT_BY_PREFIX) {
    if (action.startsWith(prefix)) return context;
  }
  return "global";
}

/** Splits "ctrl+shift+a" into a normalized chord, ordering modifiers so two
 *  spellings of the same chord compare equal. */
export function normalizeChord(text, platform = process.platform) {
  const parts = String(text).toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error(`empty chord: ${text}`);

  const held = new Set();
  let key = null;
  for (const part of parts) {
    if (part === "super") {
      held.add(platform === "darwin" ? "meta" : "ctrl");
    } else if (part === "cmd" || part === "meta") {
      held.add("meta");
    } else if (MODIFIERS.includes(part)) {
      held.add(part);
    } else {
      key = part;
    }
  }
  if (!key) throw new Error(`chord has no key: ${text}`);

  const ordered = MODIFIERS.filter((modifier) => held.has(modifier));
  return { key, modifiers: ordered, id: [...ordered, key].join("+") };
}

/** One binding spec may hold several alternatives and leader sequences:
 *  "ctrl+c,ctrl+d,<leader>q" is three ways to reach the same action. */
export function parseBindingSpec(spec, { leader, platform = process.platform } = {}) {
  if (spec === false || spec === "none" || spec === undefined || spec === null) return [];

  return String(spec)
    .split(",")
    .map((alternative) => alternative.trim())
    .filter(Boolean)
    .map((alternative) => {
      if (alternative.startsWith("<leader>")) {
        const rest = alternative.slice("<leader>".length);
        if (!leader) throw new Error(`"${alternative}" needs a leader chord`);
        return [normalizeChord(leader, platform), normalizeChord(rest, platform)];
      }
      return [normalizeChord(alternative, platform)];
    });
}

export function buildKeymap({ definitions, platform = process.platform, overrides = {} } = {}) {
  if (!Array.isArray(definitions)) throw new Error("definitions must be an array");

  const leaderEntry = definitions.find((entry) => entry.action === "leader");
  const leaderSpec = Object.hasOwn(overrides, "leader") ? overrides.leader : leaderEntry?.default;
  if (!leaderSpec || leaderSpec === "none") throw new Error("a leader chord is required");
  const leader = normalizeChord(leaderSpec, platform);

  const bindings = [];
  for (const entry of definitions) {
    if (entry.action === "leader") continue;
    const spec = Object.hasOwn(overrides, entry.action) ? overrides[entry.action] : entry.default;
    for (const sequence of parseBindingSpec(spec, { leader: leaderSpec, platform })) {
      const final = sequence[sequence.length - 1];
      bindings.push({
        action: entry.action,
        description: entry.description,
        context: contextFor(entry.action),
        sequence,
        needsLeader: sequence.length > 1,
        intercept: shouldIntercept(sequence.length > 1 ? leader : final),
      });
    }
  }

  return { leader, platform, bindings, conflicts: findConflicts(bindings) };
}

/** Two actions reachable by the same chord in the same context. The table has
 *  none on macOS, but collapsing `super` onto Control creates them elsewhere:
 *  on Windows super+a (select all) lands on ctrl+a, which the table already
 *  spends on "move to start of line". Resolution order alone would hide that,
 *  and the loser simply becomes unreachable, so report it and let the caller
 *  rebind one of them. */
function findConflicts(bindings) {
  const seen = new Map();
  const conflicts = [];
  for (const binding of bindings) {
    const key = `${binding.context}\u0000${binding.needsLeader ? "leader " : ""}${binding.sequence.at(-1).id}`;
    const previous = seen.get(key);
    if (previous) {
      conflicts.push({
        context: binding.context,
        chord: binding.sequence.at(-1).id,
        needsLeader: binding.needsLeader,
        actions: [previous.action, binding.action],
      });
    } else {
      seen.set(key, binding);
    }
  }
  return conflicts;
}

function shouldIntercept(chord) {
  if (NEVER_INTERCEPT.has(chord.id)) return false;
  return MUST_INTERCEPT.has(chord.id);
}

export function chordFromEvent(event) {
  const held = [];
  if (event.control) held.push("ctrl");
  if (event.shift) held.push("shift");
  if (event.alt) held.push("alt");
  if (event.meta) held.push("meta");
  const key = String(event.key ?? "").toLowerCase();
  if (!key) throw new Error("event has no key");
  const ordered = MODIFIERS.filter((modifier) => held.includes(modifier));
  return { key, modifiers: ordered, id: [...ordered, key].join("+") };
}

// A binding for the surface the user is actually on beats a global one. Relying
// on the position of an unknown context in a fixed list would make that work by
// accident, so the rule is stated: anything but "global" is more specific.
const specificity = (context) => (context === "global" ? 1 : 0);

/** Resolves one key event against the map.
 *
 *  Returns the matched action, whether the shell must swallow the event, and the
 *  next leader state. A pending leader is reported back rather than stored here,
 *  so the caller owns the state and it stays testable. */
export function resolve(keymap, event, { context = "global", leaderPending = false } = {}) {
  const chord = chordFromEvent(event);

  if (!leaderPending && chord.id === keymap.leader.id) {
    return { action: null, intercept: true, leaderPending: true, reason: "leader" };
  }

  const candidates = keymap.bindings.filter((binding) => {
    if (binding.needsLeader !== leaderPending) return false;
    const expected = binding.sequence[binding.sequence.length - 1];
    if (expected.id !== chord.id) return false;
    return binding.context === context || binding.context === "global";
  });

  if (candidates.length === 0) {
    return { action: null, intercept: false, leaderPending: false, reason: leaderPending ? "leader-miss" : "unbound" };
  }

  candidates.sort((a, b) => specificity(a.context) - specificity(b.context));
  const winner = candidates[0];
  return {
    action: winner.action,
    intercept: leaderPending ? true : winner.intercept,
    leaderPending: false,
    reason: "match",
  };
}

/** Every chord the shell must claim, for a one-time registration at startup. */
export function interceptedChords(keymap) {
  const ids = new Set([keymap.leader.id]);
  for (const binding of keymap.bindings) {
    if (binding.intercept) ids.add(binding.sequence[binding.sequence.length - 1].id);
  }
  return [...ids].sort();
}
