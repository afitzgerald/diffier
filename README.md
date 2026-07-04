# Diffier

An IntelliJ-style Git diff editor for macOS. It recreates the JetBrains
commit tool window and diff viewer — same layout, same keybindings, same
flow — as a standalone desktop app for reviewing, editing, and committing
working-tree changes in any Git repository.

![Diffier](docs/screenshot.png)

## Features

- **Changes tree** — changed files grouped by directory (single-child
  directory chains compressed, IntelliJ style), with tri-state checkboxes
  to pick what goes into the commit and IntelliJ's VCS status colors
  (blue = modified, green = added, red = unversioned, grey = deleted,
  teal = moved).
- **Side-by-side diff viewer** — Darcula-themed Monaco diff editor with
  syntax highlighting, HEAD on the left, your working tree on the right.
  The right side is **editable**: type directly in the diff, changes
  autosave when you switch files (⌘S to save explicitly). Per-chunk revert
  arrows in the gutter, unified-view toggle, and an ignore-whitespace
  toggle.
- **IntelliJ navigation flow** — step through every difference in every
  file without touching the mouse: `F7` walks the differences, and at the
  last one a hint arms a second `F7` press to continue into the next
  changed file (exactly like IntelliJ's "Press F7 to go to the next file").
- **Commit tool window** — commit message box, Amend checkbox (pre-fills
  the last message), Commit / Commit and Push buttons. Commits are
  pathspec-limited to the checked files, so anything staged from the CLI
  that you didn't check stays out of the commit.
- **Rollback** — IntelliJ semantics: tracked files revert to HEAD, renames
  are undone, unversioned files are deleted (with confirmation).
- **Live updates** — a file watcher refreshes the tree when the working
  tree or `.git` changes (commits from a terminal show up immediately).

## Keybindings (IntelliJ keymap)

| Key | Action |
| --- | --- |
| `F7` / `⇧F7` | Next / previous difference; at the last one, press again to continue into the next file |
| `⌘⇧]` / `⌘⇧[` | Next / previous changed file |
| `⌥→` / `⌥←` | Next / previous changed file (when the tree has focus) |
| `↑` `↓` in tree | Select file (diff preview follows the selection) |
| `→` / `←` in tree | Expand / collapse directory |
| `Space` in tree | Toggle the commit checkbox (directories toggle the subtree) |
| `⏎` in tree | Jump into the diff editor |
| `Esc` | Back to the changes tree |
| `⌘K` | Commit (focus the message box) |
| `⌘⏎` | Commit checked files |
| `⌥⌘⏎` | Commit and Push |
| `⌘⇧K` | Push |
| `⌥⌘Z` | Rollback selected file / directory |
| `⌘S` | Save the edited file |
| `⌘0` | Toggle the commit tool window |
| `⌘O` | Open a repository |
| `⌘R` | Refresh file status |

## Running

```sh
npm install
npm start
```

The app reopens the last repository on launch; use `⌘O` to pick another.

## Building the macOS app

On a Mac:

```sh
npm install
npm run dist        # produces dist/Diffier-<version>.dmg and .zip
```

## Development & tests

- `npm test` — integration tests for the Git layer (`main/git.js`) against
  a throwaway repository: status parsing for every change type, renames,
  diffs, partial commits, amend, rollback, binary detection, path-escape
  protection.
- `node test/ui.test.js` — end-to-end UI test. The renderer talks to the
  main process only through `window.api`, so the test serves the renderer
  over HTTP with an RPC shim backed by the real Git layer and drives the
  full flow (tree, F7 navigation, editing + autosave, commit, rollback)
  with Playwright. Set `DIFFIER_CHROMIUM` to your Chromium binary if it is
  not at `/opt/pw-browsers/chromium`.
- `npm run smoke` — boots the real Electron app, loads the repo from
  `DIFFIER_SMOKE_REPO`, and fails on any renderer error.

## Architecture

```
main/
  main.js      Electron main process: window, menu (IntelliJ accelerators),
               IPC, settings persistence, recursive file watcher
  git.js       All Git operations (spawns the git CLI; no native deps)
  preload.js   contextBridge API — the renderer has no Node access
renderer/
  index.html   Layout: commit panel, diff toolbar, Monaco container
  styles.css   Darcula theme
  app.js       Tree model, Monaco diff editor, keymap, commit flow
```
