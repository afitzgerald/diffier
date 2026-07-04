# Diffier — notes for coding agents

Electron app: an IntelliJ-style Git commit tool window + diff viewer.
No bundler, no framework, no native deps — plain TypeScript everywhere,
compiled **in place** (`.ts` → `.js` next to it, same filename); git is
spawned via the CLI (`main/git.ts`), Monaco renders the diffs.

## TypeScript — in-place compilation, not a bundler

Every runtime source file is `.ts`; `tsc` emits the `.js` right next to
it (same directory, same basename) so every existing relative path
(`<script>` tags, `require()`, electron-builder globs) keeps working
unmodified. The compiled `.js` files are committed to the repo — running
the app or tests never requires a build step, but **editing a `.ts` file
requires recompiling before the change takes effect** (`npm run build`,
or let `pretest`/`prestart`/`presmoke`/`predist` do it for you).

- `npm run typecheck` — `tsc --noEmit` across all four programs (main,
  renderer, highlighter entry, tests). Run this after any `.ts` edit.
- `npm run build` — same three emit-producing programs, actually writing
  `.js`. Wired as a `pre*` hook on `start`/`smoke`/`test`/`dist`.
- Four separate `tsconfig*.json` (`main`, `renderer`, `highlighter`,
  `test`) because the main process (Node types), renderer (DOM + the
  ambient Monaco global), highlighter bundle entry (real ESM, no
  `types`), and tests (Node + DOM, for Playwright's `page.evaluate`)
  are incompatible type-checking environments. Domain types shared
  between processes live in `main/git-types.ts`, `main/keymap-types.ts`,
  `main/api-types.ts` (zero Node deps, so the renderer program can import
  them) and are re-declared as bare globals in `renderer/global.d.ts` for
  the classic-script files to use without an `import`.
- `renderer/app/*.ts` and `renderer/languages.ts` are **global scripts**
  (no top-level `import`/`export`) — see the section below; they merge
  into one shared type-checking scope, same as their runtime scope.

## Architecture in one breath

`main/git.ts` (all git operations) ← `main/main.ts` (IPC `handle()` +
menu) ← `main/preload.ts` (contextBridge `window.api`) ← `renderer/app/*`
(UI). The renderer never touches Node — everything crosses `window.api`.

## Renderer modules are classic scripts — load order is law

`renderer/app/*.ts` are **classic** `<script>` tags (not ES modules; the
app runs from `file://` and loads the compiled `.js`). They share one
global lexical scope, loaded in the order listed in `renderer/index.html`
(core → features → boot).

- Function declarations hoist **per file only**. Load-time (top-level)
  code must never reference a `const`/`let`/function from a
  **later-loaded** file — that's a startup `ReferenceError`. References
  inside event handlers/callbacks are fine (resolved at call time).
- New shared state goes in `renderer/app/core.ts` (`state`), new startup
  wiring in `boot.ts`, and new files get a `<script>` tag in
  `index.html` at the right position (pointing at the compiled `.js`)
  plus an entry in `tsconfig.renderer.json`'s `include`.

## Diff pane modes (invariants, not enforced by types)

Exactly one of these is active; the others must be null/cleared:

- `state.current` — editable worktree diff (autosave writes to
  `state.current.path`!)
- `state.readOnlyDiff` (`{hash, path}`) — commit diff from the Log tab
  (`state.current` must be null or autosave corrupts the worktree)
- `state.conflict` — conflict-resolution editor session

`openDiff` / `openCommitFileDiff` / `clearDiffView` maintain this by
assignment order. Guards that re-derive the mode live in
`staging.ts` (`hunkStagingActive`), `diff-view.ts` (`editableModel`),
`blame.ts`, and `repo.ts` (`refreshStatus`). Touch any mode field →
re-check all of them.

## Adding things — the full checklist

A new **git operation** touches five places, in order:
1. `main/git-types.ts` — the return/param types (pure interfaces, zero
   runtime deps — this is what the renderer program imports).
2. `main/git.ts` — the function. Any `relPath` argument must go through
   `insideRepo(root, relPath)` before touching the filesystem.
3. `main/main.ts` — `handle('git:x', ...)` (wraps errors into
   `{ok, error}`).
4. `main/api-types.ts` (`DiffierApi`) and `main/preload.ts` —
   `gitX: (...) => call('git:x', ...)`, same arg order.
5. `test/ui.test.ts` — add the channel to **both** the `rpc` map and the
   `API_SHIM` channels map. Skipping this makes the renderer's call
   reject at UI-test runtime, not at review time.

A new **user action**: `main/keymap-types.ts` `ACTIONS` (default binding
or `null`), renderer `actions.ts` `ACTION_IMPL`, and a `mi('id', 'Label')`
menu item in `main/main.ts` `buildMenu()`. All three or it half-works.

A new **popup**: use `registerPopup()` in `renderer/app/popups.ts` —
never hand-wire an anchor click toggle; the global mousedown-closer
needs the popup↔anchor pairing or toggle-off breaks.

## Git layer conventions (`main/git.ts`)

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
- Monaco injects `<style>` blocks at runtime for theme/token colors —
  the CSP's `style-src` **must** keep `'unsafe-inline'`; removing it
  breaks all editor coloring (confirmed by hand, not just suspected —
  `script-src`/`font-src`/`default-src` were tightened without issue,
  only `style-src` couldn't be).

## Testing

- `npm test` — recompiles (`pretest` → `npm run build`), then runs
  pure-node tests (git layer, keymap, themes, languages).
  `test/git.test.ts` builds throwaway repos; extend it for any git.ts
  change.
- `node test/ui.test.js` — full Playwright E2E against the real
  renderer + real git layer over an HTTP shim (Chromium at
  `/opt/pw-browsers/chromium`, override with `DIFFIER_CHROMIUM`). Run
  `npm run build` first (it's not wired to a `pretest`-style hook since
  it's invoked directly, not via `npm test`); run it before claiming any
  renderer change works. Edit `test/ui.test.ts`, not the compiled
  `test/ui.test.js`.
- `npm run smoke` — boots real Electron headless-ish; needs the Electron
  binary (often unavailable in sandboxes; the UI test is the substitute).
- `npm run typecheck` — fast `--noEmit` check across all four
  `tsconfig*.json` programs; run after any `.ts` edit even if you're not
  about to run the full suite.

## Misc

- Settings persist to `settings.json` in `userData` via
  `settings:set` (merge-patch semantics). Keymap overrides live under
  `keymap`; `null` means explicitly unbound.
- Every keybinding is user-rebindable: never hardcode a shortcut string
  in UI text — use `actionShortcut(id)` / `updateShortcutHints()`.
- Themes are data (`main/themes.ts`): CSS variables + a Monaco theme +
  shiki mapping. New colors must be added to **every** theme; the theme
  test asserts consistent variable sets.
