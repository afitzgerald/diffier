# Diffier — notes for coding agents

Electron app: an IntelliJ-style Git commit tool window + diff viewer.
No bundler, no framework, no native deps — plain JS everywhere; git is
spawned via the CLI (`main/git.js`), Monaco renders the diffs.

## Architecture in one breath

`main/git.js` (all git operations) ← `main/main.js` (IPC `handle()` +
menu) ← `main/preload.js` (contextBridge `window.api`) ← `renderer/app/*`
(UI). The renderer never touches Node — everything crosses `window.api`.

## Renderer modules are classic scripts — load order is law

`renderer/app/*.js` are **classic** `<script>` tags (not ES modules; the
app runs from `file://`). They share one global lexical scope, loaded in
the order listed in `renderer/index.html` (core → features → boot).

- Function declarations hoist **per file only**. Load-time (top-level)
  code must never reference a `const`/`let`/function from a
  **later-loaded** file — that's a startup `ReferenceError`. References
  inside event handlers/callbacks are fine (resolved at call time).
- New shared state goes in `renderer/app/core.js` (`state`), new startup
  wiring in `boot.js`, and new files get a `<script>` tag in
  `index.html` at the right position.

## Diff pane modes (invariants, not enforced by types)

Exactly one of these is active; the others must be null/cleared:

- `state.current` — editable worktree diff (autosave writes to
  `state.current.path`!)
- `state.readOnlyDiff` (`{hash, path}`) — commit diff from the Log tab
  (`state.current` must be null or autosave corrupts the worktree)
- `state.conflict` — conflict-resolution editor session

`openDiff` / `openCommitFileDiff` / `clearDiffView` maintain this by
assignment order. Guards that re-derive the mode live in
`staging.js` (`hunkStagingActive`), `diff-view.js` (`editableModel`),
`blame.js`, and `repo.js` (`refreshStatus`). Touch any mode field →
re-check all of them.

## Adding things — the full checklist

A new **git operation** touches four places, in order:
1. `main/git.js` — the function. Any `relPath` argument must go through
   `insideRepo(root, relPath)` before touching the filesystem.
2. `main/main.js` — `handle('git:x', ...)` (wraps errors into
   `{ok, error}`).
3. `main/preload.js` — `gitX: (...) => call('git:x', ...)`, same arg
   order.
4. `test/ui.test.js` — add the channel to **both** the `rpc` map and the
   `API_SHIM` channels map. Skipping this makes the renderer's call
   reject at UI-test runtime, not at review time.

A new **user action**: `main/keymap.js` `ACTIONS` (default binding or
`null`), renderer `actions.js` `ACTION_IMPL`, and a `mi('id', 'Label')`
menu item in `main/main.js` `buildMenu()`. All three or it half-works.

A new **popup**: use `registerPopup()` in `renderer/app/popups.js` —
never hand-wire an anchor click toggle; the global mousedown-closer
needs the popup↔anchor pairing or toggle-off breaks.

## Git layer conventions (`main/git.js`)

- All git calls via `git()`/`gitRaw()`/`gitOpts()` (execFile, never
  shell). Machine-readable output uses NUL (`%x00`) field / SOH
  (`%x01`) record separators — parse with `parseRecords()`, don't split
  on newlines (branch names, messages, and authors can contain almost
  anything).
- Always handle: empty repo (no HEAD), detached HEAD, merge in progress
  (`git commit -- <paths>` is **fatal** mid-merge; per-hunk commits are
  refused then), renames (`origPath`), and binary content (`looksBinary`).
- Partial (per-hunk) commits go through a temp index
  (`GIT_INDEX_FILE`): never touch the user's real index; hash blobs
  with `hash-object --path` so `.gitattributes` filters apply; amend
  must preserve author name/email/date.

## Monaco gotchas (cost us real time)

- Injected text (`options.after`) on an **empty range** renders only
  with `showIfCollapsed: true` — silently dropped otherwise.
- Workers are disabled (file://); diffs compute on the main thread —
  keep per-diff-update work O(small), it runs on every keystroke.
- For pure deletions `modifiedEndLineNumber === 0`; `changeStartLine()`
  clamps to the model — use it, don't recompute.
- F7/⇧F7 are unbound from Monaco at boot; difference navigation is ours.

## Testing

- `npm test` — pure-node tests (git layer, keymap, themes, languages).
  `test/git.test.js` builds throwaway repos; extend it for any git.js
  change.
- `node test/ui.test.js` — full Playwright E2E against the real
  renderer + real git layer over an HTTP shim (Chromium at
  `/opt/pw-browsers/chromium`, override with `DIFFIER_CHROMIUM`). Run it
  before claiming any renderer change works.
- `npm run smoke` — boots real Electron headless-ish; needs the Electron
  binary (often unavailable in sandboxes; the UI test is the substitute).

## Misc

- Settings persist to `settings.json` in `userData` via
  `settings:set` (merge-patch semantics). Keymap overrides live under
  `keymap`; `null` means explicitly unbound.
- Every keybinding is user-rebindable: never hardcode a shortcut string
  in UI text — use `actionShortcut(id)` / `updateShortcutHints()`.
- Themes are data (`main/themes.js`): CSS variables + a Monaco theme +
  shiki mapping. New colors must be added to **every** theme; the theme
  test asserts consistent variable sets.
