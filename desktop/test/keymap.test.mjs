import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  buildKeymap,
  chordFromEvent,
  contextFor,
  interceptedChords,
  normalizeChord,
  parseBindingSpec,
  resolve,
} from '../src/keymap.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const definitions = JSON.parse(
  fs.readFileSync(path.join(here, '..', 'src', 'keybinds', 'opencode-1.18.18.json'), 'utf8'),
);

const press = (key, held = {}) => ({
  key,
  control: held.ctrl ?? false,
  shift: held.shift ?? false,
  alt: held.alt ?? false,
  meta: held.meta ?? false,
});

test('the vendored table is the one the host runs, not a hand-written subset', () => {
  assert.equal(definitions.length, 184);
  const leader = definitions.find((entry) => entry.action === 'leader');
  assert.equal(leader.default, 'ctrl+x');
  assert.equal(definitions.filter((entry) => entry.default === 'none').length, 43);
});

test('a leader press is swallowed and remembered rather than acted on', () => {
  const keymap = buildKeymap({ definitions, platform: 'darwin' });

  const first = resolve(keymap, press('x', { ctrl: true }));
  assert.equal(first.action, null);
  assert.equal(first.leaderPending, true);
  // ctrl+x is Cut inside a text field, so the shell has to take it or the
  // prompt loses its selection every time the user reaches for a leader binding.
  assert.equal(first.intercept, true);

  const second = resolve(keymap, press('n'), { leaderPending: true });
  assert.equal(second.action, 'session_new');
  assert.equal(second.leaderPending, false);
});

test('a plain key is not confused with the same key after the leader', () => {
  const keymap = buildKeymap({ definitions, platform: 'darwin' });

  const afterLeader = resolve(keymap, press('l'), { leaderPending: true });
  assert.equal(afterLeader.action, 'session_list');

  const withoutLeader = resolve(keymap, press('l'));
  assert.equal(withoutLeader.action, null);
  assert.equal(withoutLeader.reason, 'unbound');
});

test('an unrecognised key after the leader drops the pending state instead of sticking', () => {
  const keymap = buildKeymap({ definitions, platform: 'darwin' });

  const miss = resolve(keymap, press('§'), { leaderPending: true });
  assert.equal(miss.action, null);
  assert.equal(miss.leaderPending, false);
  assert.equal(miss.reason, 'leader-miss');
});

test('claims the keys a window would otherwise spend on itself', () => {
  const keymap = buildKeymap({ definitions, platform: 'darwin' });

  // Left unclaimed, ctrl+w closes the window in the middle of a session and tab
  // moves focus out of the prompt.
  const deleteWord = resolve(keymap, press('w', { ctrl: true }), { context: 'input' });
  assert.equal(deleteWord.action, 'input_delete_word_backward');
  assert.equal(deleteWord.intercept, true);

  const cycleAgent = resolve(keymap, press('tab'));
  assert.equal(cycleAgent.action, 'agent_cycle');
  assert.equal(cycleAgent.intercept, true);
});

test('leaves paste to the platform, as the table itself asks', () => {
  const keymap = buildKeymap({ definitions, platform: 'darwin' });

  const paste = resolve(keymap, press('v', { ctrl: true }), { context: 'input' });
  assert.equal(paste.action, 'input_paste');
  assert.equal(paste.intercept, false);
});

test('maps super to Command on macOS and to Control elsewhere', () => {
  assert.equal(normalizeChord('super+a', 'darwin').id, 'meta+a');
  assert.equal(normalizeChord('super+a', 'win32').id, 'ctrl+a');

  const mac = buildKeymap({ definitions, platform: 'darwin' });
  assert.equal(resolve(mac, press('a', { meta: true }), { context: 'input' }).action, 'input_select_all');
});

test('only the collisions that no static table can resolve are left', () => {
  const mac = buildKeymap({ definitions, platform: 'darwin' });
  const described = mac.conflicts
    .map((conflict) => `${conflict.context} ${conflict.needsLeader ? '<leader>' : ''}${conflict.chord}: ${conflict.actions.sort().join(' vs ')}`)
    .sort();

  // Splitting the dialogs apart and scoping the list-only actions takes this
  // from thirteen collisions down to three, and each survivor is irreducible:
  //   - the upstream table binds <leader>q twice,
  //   - up and down are cursor movement or history depending on where the
  //     cursor sits, which is a runtime fact the renderer owns.
  // Pinning the set means a future change cannot quietly add a fourth.
  assert.deepEqual(described, [
    'global <leader>q: app_exit vs session_queued_prompts',
    'input down: history_next vs input_move_down',
    'input up: history_previous vs input_move_up',
  ]);
});

test('reports the collisions that collapsing super onto Control creates on Windows', () => {
  const win = buildKeymap({ definitions, platform: 'win32' });

  // super+a (select all) lands on ctrl+a, which the table already spends on
  // "move to start of line". Whichever loses becomes unreachable, so the map
  // has to say so rather than let resolution order decide in silence.
  const selectAll = win.conflicts.find((conflict) => conflict.actions.includes('input_select_all'));
  assert.ok(selectAll, 'expected the ctrl+a collision to be reported');
  assert.equal(selectAll.chord, 'ctrl+a');
  assert.deepEqual(selectAll.actions.sort(), ['input_line_home', 'input_select_all']);

  // Until someone rebinds one of them, the table's own order decides.
  assert.equal(resolve(win, press('a', { ctrl: true }), { context: 'input' }).action, 'input_line_home');

  const rebound = buildKeymap({ definitions, platform: 'win32', overrides: { input_line_home: 'alt+left' } });
  assert.equal(rebound.conflicts.some((conflict) => conflict.chord === 'ctrl+a'), false);
  assert.equal(resolve(rebound, press('a', { ctrl: true }), { context: 'input' }).action, 'input_select_all');
});

test('a more specific context wins over a global binding on the same key', () => {
  const keymap = buildKeymap({ definitions, platform: 'darwin' });

  // escape is both "close the diff viewer" and "interrupt the session". Inside
  // the diff viewer the specific one has to win, or the viewer becomes a trap
  // that aborts the run when the user tries to leave it.
  assert.equal(resolve(keymap, press('escape'), { context: 'diff' }).action, 'diff_close');
  assert.equal(resolve(keymap, press('escape'), { context: 'messages' }).action, 'session_interrupt');
});

test('an action the table leaves unbound produces no binding', () => {
  const keymap = buildKeymap({ definitions, platform: 'darwin' });

  assert.equal(keymap.bindings.some((binding) => binding.action === 'diff_open'), false);
  assert.equal(keymap.bindings.some((binding) => binding.action === 'session_fork'), false);
});

test('an override can bind an unbound action, rebind a bound one, or switch the leader', () => {
  const keymap = buildKeymap({
    definitions,
    platform: 'darwin',
    overrides: { diff_open: '<leader>d', session_new: false, leader: 'alt+x' },
  });

  assert.equal(keymap.leader.id, 'alt+x');
  assert.equal(resolve(keymap, press('x', { alt: true })).leaderPending, true);
  assert.equal(resolve(keymap, press('d'), { leaderPending: true }).action, 'diff_open');
  assert.equal(keymap.bindings.some((binding) => binding.action === 'session_new'), false);
});

test('one action may be reachable by several chords', () => {
  const keymap = buildKeymap({ definitions, platform: 'darwin' });
  const exits = keymap.bindings.filter((binding) => binding.action === 'app_exit');

  // app_exit is "ctrl+c,ctrl+d,<leader>q" in the table.
  assert.equal(exits.length, 3);
  assert.equal(exits.filter((binding) => binding.needsLeader).length, 1);
});

test('derives a context from the action name, and states the few it cannot', () => {
  assert.equal(contextFor('input_submit'), 'input');
  assert.equal(contextFor('diff_next_hunk'), 'diff');
  assert.equal(contextFor('messages_page_up'), 'messages');
  assert.equal(contextFor('session_new'), 'global');

  // One dialog is open at a time, so each gets its own context; sharing one
  // would collide every dialog's Enter and arrows with every other dialog's.
  assert.equal(contextFor('dialog.select.next'), 'dialog:select');
  assert.equal(contextFor('prompt.autocomplete.next'), 'dialog:autocomplete');

  // These are scoped to a list in the TUI but carry no prefix that says so, and
  // they are exactly the ones that collided on ctrl+d and ctrl+f.
  assert.equal(contextFor('session_delete'), 'dialog:select');
  assert.equal(contextFor('stash_delete'), 'dialog:stash');
  assert.equal(contextFor('model_favorite_toggle'), 'dialog:model');

  // And the opener of a surface belongs outside it.
  assert.equal(contextFor('diff_open'), 'global');
});

test('reports the chord set to claim once at startup', () => {
  const keymap = buildKeymap({ definitions, platform: 'darwin' });
  const claimed = interceptedChords(keymap);

  assert.ok(claimed.includes('ctrl+x'));
  assert.ok(claimed.includes('ctrl+w'));
  assert.ok(claimed.includes('tab'));
  assert.equal(claimed.includes('ctrl+v'), false);
});

test('rejects a malformed chord instead of silently never matching', () => {
  assert.throws(() => normalizeChord('ctrl+'), /no key/);
  assert.throws(() => normalizeChord(''), /empty chord/);
  assert.throws(() => parseBindingSpec('<leader>n', {}), /needs a leader/);
  assert.throws(() => buildKeymap({ definitions, overrides: { leader: 'none' } }), /leader chord is required/);
  assert.throws(() => chordFromEvent({ key: '' }), /no key/);
});
