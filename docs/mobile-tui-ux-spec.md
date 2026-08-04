# OpenCode Mobile TUI UX Alignment Spec

Status: approved working contract  
Applies to: `opencode-mobile/` Expo app  
Primary upstream reference: `anomalyco/opencode` current TUI, commit `34e58090595d44e3e7cc37498f16753a98627456`, under `packages/tui`  
Non-reference: archived legacy `opencode-ai/opencode` Go TUI

This file freezes the mobile UX direction so implementation does not drift as pages are added. The mobile app is not a simplified chat wrapper and not a project-management dashboard. It is a touch adaptation of the active OpenCode TUI interaction model.

## Source Of Truth

- Upstream product behavior follows `anomalyco/opencode`, not the archived `opencode-ai/opencode` implementation.
- TUI areas to keep aligned:
  - `packages/tui/src/routes/session/index.tsx`
  - `packages/tui/src/component/prompt/index.tsx`
  - `packages/tui/src/routes/session/permission.tsx`
  - `packages/tui/src/config/keybind.ts`
- Public reference docs:
  - https://opencode.ai/docs/tui/
  - https://github.com/anomalyco/opencode/tree/0abbcdd/packages/tui

## Core UX Contract

1. Host is only the mobile connection shell.
   - Selecting a host must lead into an OpenCode-style prompt-first home/workbench.
   - Host selection must not turn the app into a project-list-first admin backend.
   - Project, workspace, and session selection belong in selectors and the command palette.

2. The primary experience is Session Workbench.
   - Session pages contain the message stream plus a bottom prompt, matching TUI priorities.
   - The TUI sidebar becomes a mobile drawer opened from the top-right overflow control.
   - The drawer carries session title, workspace, share URL, LSP/MCP, context, todos, file changes, status, and subagents.

3. Command Palette is the main operation entry.
   - TUI `ctrl+p` maps to the top-right overflow menu and then a command sheet.
   - The first-level overflow menu must include: `Commands`, `Session details`, `Subagents`, `Diffs`, `Settings`.
   - The command palette must carry TUI-equivalent operations including Share, Rename, Timeline, Fork, Compact, Undo, Redo, Copy, Export, Toggle thinking/actions/timestamps/sidebar.

4. Prompt must align with TUI prompt behavior.
   - The bottom input is not a generic chat box.
   - Required prompt semantics: `/` commands, `@` file/reference/agent autocomplete, agent/model/variant display and switching, shell mode, attachment/paste affordances, history/stash.
   - Footer metadata must show current agent, model, thinking/variant, token/cost or current session status when available.

5. Permission UX is three-way and blocking.
   - Permission requests must use `Allow once`, `Allow always`, and `Reject`.
   - Reject must allow the user to enter guidance for what OpenCode should do differently.
   - Pending permission blocks normal prompt submission and is surfaced in the prompt footer.

6. QuestionPrompt behavior must be preserved.
   - Pending state comes from `GET /question` plus `question.asked`, `question.replied`, and `question.rejected` SSE events. Historical transcript tool parts are not pending-state authority.
   - One request can contain multiple questions. Preserve the TUI's per-question tabs plus Confirm tab, ordered `string[][]` answers, single choice, multi choice, custom answer, and reject flows.
   - A single-choice question may auto-submit only when custom answers are disabled. If custom is allowed, an explicit submit action must remain available.
   - External answers from another TUI must remove the card immediately. A stale in-flight `GET /question` response must never resurrect a request already removed by SSE.
   - Questions must not be flattened into passive transcript messages.

7. Tool messages render by semantic type.
   - Bash, Grep, Read, WebFetch, WebSearch, and Task render as inline tool rows.
   - Edit, ApplyPatch, Write, Todo, and Question render as block cards.
   - Diff defaults to unified diff with word wrap on phone.
   - Split diff is allowed for tablet or landscape layouts.
   - Tool protocol envelopes, call IDs, skill payloads, and arbitrary input/output JSON stay hidden from the normal transcript. The default row shows the official TUI-style semantic summary; raw substrate is available only through explicit `Copy raw` or `Open text view`.
   - Shell/Bash keeps the complete command visible with the `$ ` prefix. Display output is
     the trimmed, ANSI-stripped string from `state.metadata.output` (legacy output fields
     are compatibility fallbacks only). The collapsed preview follows the official TUI
     contract: 10 lines, a character budget of
     `10 * max(20, contentColumns - 6)`, Unicode code-point counting, and a head-only `…`
     marker. Overflow exposes `Click to expand` / `Click to collapse`; expansion shows the
     complete cleaned metadata window.

8. Status and interrupt behavior follow TUI semantics.
   - Keep busy, retry, and idle states visible.
   - Running prompt state shows spinner/status.
   - Interrupt must not be a bare destructive button. It must use `esc again to interrupt` equivalent behavior: first tap arms, second tap inside a short window confirms.

9. Transcript scrolling follows sticky-bottom semantics.
   - The client follows every message `nextCursor` until exhaustion. Cross-page message
     runs are globally normalized by message creation time; a repeated cursor fails instead
     of looping. Parts inside a message preserve server array order because not every part
     has a timestamp or an ordinal field.
   - The complete transcript remains in state for copy/export and semantic controls. Native
     layout starts with the latest 100 messages and exposes older history in bounded
     100-message windows so a large cache never becomes one monolithic Fabric update.
   - The transcript uses an inverted virtual list: the final part of the newest message is
     native offset zero, so opening a session starts there even when the newest message is
     taller than the viewport.
   - New streamed content remains the bottom only while the user is already at the bottom.
   - If the user scrolls up, new content must not steal position. The one-tap Latest action
     makes exactly one non-animated native offset-zero jump; it has no timer, layout retry,
     or intermediate animation-event feedback loop, and stays present until native offset
     confirms the latest edge.
   - Native platform scrollbars are hidden. Any visible scroll indicator uses the active OpenCode theme tokens.

10. Root sessions and subagents are separate navigation surfaces.
   - Recent sessions, session selectors, workspace counts, and `@session` autocomplete contain only sessions without `parentID`.
   - Child sessions remain reachable from Subagent cards, the Subagents drawer, and direct child transcript routes.
   - Agent selectors contain only non-hidden agents whose mode is not `subagent`; model/variant restoration follows the last user message and persisted prompt preferences.

## Hard Mobile Mappings

1. Side panel.
   - Top-right `...` opens the session drawer.
   - Drawer is hidden by default on phone and does not occupy persistent layout space.

2. Ctrl+P / command palette.
   - Top-right `...` exposes `Commands`.
   - `Commands` opens the full-screen or bottom command palette.

3. Subagent card.
   - Transcript keeps a visible subagent card.
   - Tapping the card opens the corresponding child session transcript.
   - Card must show running/completed/retry status, tool-call count, and elapsed time when the API provides enough metadata.

4. Agent, thinking, interrupt.
   - TUI `Tab` agent switch maps to the prompt agent selector/chip.
   - TUI `ctrl+t` thinking switch maps to the thinking/variant chip; tap cycles, long press or menu opens explicit selection.
   - TUI `esc` interrupt maps to the armed double-tap interrupt control.

5. User message operations.
   - Tap or long press on user messages opens actions: `Fork from here`, `Revert to here` / `Undo`, `Copy`, `Jump` / `Timeline`.
   - If API or metadata support is missing, keep the entry visible but disabled with a concrete reason.

6. Text selection and copy.
   - Assistant text, tool result, bash output, diff raw text, reasoning, error, and user message text must be copyable.
   - Plain text uses selectable text where React Native supports it.
   - Complex tool and diff cards must expose `Copy`, `Copy raw`, and `Open text view`.
   - If nested selectable text is unstable on a platform, `Open text view` is the required fallback so anything can still be copied.

## Official TUI Visual Contract

- Mobile visual tokens must be derived from the active official `anomalyco/opencode` TUI theme model, not from an invented mobile palette.
- The default mobile theme is the official `opencode` dark theme: `background`, `backgroundPanel`, `backgroundElement`, `backgroundMenu`, `border`, `borderActive`, `borderSubtle`, `primary`, `secondary`, `accent`, `error`, `warning`, `success`, `info`, markdown, syntax, and diff tokens.
- Available official TUI theme names and JSON assets must stay available to mobile settings/theme plumbing: `aura`, `ayu`, `catppuccin`, `catppuccin-frappe`, `catppuccin-macchiato`, `cobalt2`, `cursor`, `dracula`, `everforest`, `flexoki`, `github`, `gruvbox`, `kanagawa`, `material`, `matrix`, `mercury`, `monokai`, `nightowl`, `nord`, `one-dark`, `osaka-jade`, `opencode`, `orng`, `lucent-orng`, `palenight`, `rosepine`, `solarized`, `synthwave84`, `tokyonight`, `vesper`, `vercel`, `zenburn`, `carbonfox`.
- Screen background uses `background`; message blocks, dialogs, and session cards use `backgroundPanel`; prompt input, chips, and hover-like secondary controls use `backgroundElement`; menus and autocomplete surfaces use `backgroundMenu`.
- User and agent message cards keep the TUI-style left border role color. Agent color derivation follows the official cycle: `secondary`, `accent`, `success`, `warning`, `primary`, `error`, `info`.
- Tool, permission, question, diff, markdown, and code surfaces must use the official semantic token groups rather than ad hoc warning/info/error background colors.
- Navigation chrome, tab bar, command sheets, prompt dock, and text-view fallbacks must use the same theme tokens so the app does not visually split into an OS-default shell around a TUI-like body.

## Implementation Guardrails

- Any UX change that contradicts this file requires explicit user approval before implementation.
- TDD should include unit tests for mappings that can be expressed without a simulator: command entries, subagent navigation intent, user-message actions, copy fallbacks, thinking cycling, and interrupt arming.
- End-to-end testing against the real VPS must cover at least host connection, health check, session loading, prompt dispatch, transcript refresh, and one command/overflow surface.
- The original product spec in `docs/opencode-mobile-spec.md` remains useful for API and architecture, but this file wins for UX hierarchy and TUI behavior.
