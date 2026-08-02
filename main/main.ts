'use strict';

import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as gitlib from './git';
import * as keymap from './keymap';
import { THEMES, DEFAULT_THEME } from './themes';
import type { ActionId, Binding } from './keymap';
import type { CommitOptions, ConfirmOptions, RepoInfo, RollbackTarget, Settings } from './api-types';
import type { ThemeId } from './themes';

const SMOKE = process.env.DIFFIER_SMOKE === '1';

// One repo per window: each BrowserWindow gets its own repo/watcher state,
// keyed by window id. `repoWindows` is the reverse index (repo root -> window
// id) used to dedupe — opening a repo that's already open elsewhere focuses
// that window instead of opening a second one.
interface WindowState {
  win: BrowserWindow;
  repoRoot: string | null;
  watcher: fs.FSWatcher | null;
  watchTimer: ReturnType<typeof setTimeout> | undefined;
  // Directory to open once this window's renderer asks for `repo:last`
  // (set for windows created to point at a specific repo — CLI, dock drop,
  // "Open Recent" into a fresh window — as opposed to the initial window,
  // which falls back to argv/settings).
  pendingRepoDir: string | undefined;
  isPrimaryWindow: boolean;
}

const windowStates = new Map<number, WindowState>();
const repoWindows = new Map<string, number>();

function stateForWindow(win: BrowserWindow): WindowState | undefined {
  return windowStates.get(win.id);
}

function focusedState(): WindowState | null {
  const focused = BrowserWindow.getFocusedWindow();
  return focused ? stateForWindow(focused) ?? null : null;
}

// ---------------------------------------------------------------- settings

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Settings;
  } catch {
    return {};
  }
}

function saveSettings(patch: Partial<Settings>): Settings {
  const merged = { ...loadSettings(), ...patch };
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2));
  } catch {
    /* non-fatal */
  }
  return merged;
}

// ----------------------------------------------------------------- watcher

function stopWatching(state: WindowState): void {
  if (state.watcher) {
    state.watcher.close();
    state.watcher = null;
  }
  clearTimeout(state.watchTimer);
  state.watchTimer = undefined;
}

function startWatching(state: WindowState, root: string): void {
  stopWatching(state);
  try {
    state.watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (filename) {
        const f = String(filename).replace(/\\/g, '/');
        // Ignore .git internals except the bits that change on commit/branch
        // switch, so CLI-side commits still refresh the UI.
        if (f.startsWith('.git/') || f === '.git') {
          const interesting =
            f === '.git/HEAD' || f === '.git/index' || f.startsWith('.git/refs/');
          if (!interesting) return;
        }
        if (f.endsWith('.git/index.lock')) return;
      }
      clearTimeout(state.watchTimer);
      state.watchTimer = setTimeout(() => {
        if (!state.win.isDestroyed()) state.win.webContents.send('repo:changed');
      }, 400);
    });
  } catch {
    // Recursive fs.watch unavailable — the renderer also refreshes on focus.
  }
}

// -------------------------------------------------------------------- repo

// Binds `dir`'s repo to `state`'s window unconditionally — callers that care
// about the one-window-per-repo invariant must dedupe first (see
// `openRepoDeduped`). Used directly by the `repo:last` boot path, where a
// dupe is impossible (the window is brand new).
async function openRepo(state: WindowState, dir: string): Promise<RepoInfo> {
  if (!(await gitlib.isRepo(dir))) {
    throw new Error(`Not a Git repository: ${dir}`);
  }
  const root = await gitlib.repoRoot(dir);
  if (state.repoRoot && state.repoRoot !== root && repoWindows.get(state.repoRoot) === state.win.id) {
    repoWindows.delete(state.repoRoot);
  }
  state.repoRoot = root;
  repoWindows.set(root, state.win.id);
  startWatching(state, root);
  const recents = [
    root,
    ...(loadSettings().recentRepos || []).filter((r) => r !== root),
  ].slice(0, 10);
  saveSettings({ lastRepo: root, recentRepos: recents });
  return {
    root,
    name: path.basename(root),
    isWorktree: await gitlib.isLinkedWorktree(root),
    recents,
  };
}

function requireRepo(state: WindowState): string {
  if (!state.repoRoot) throw new Error('No repository is open');
  return state.repoRoot;
}

function windowForRepoRoot(root: string): BrowserWindow | null {
  const id = repoWindows.get(root);
  if (id == null) return null;
  const w = BrowserWindow.fromId(id);
  return w && !w.isDestroyed() ? w : null;
}

// The one-window-per-repo gate: if `dir`'s repo is already open in another
// window, focus it and return null. Otherwise open it into `currentState`
// (an existing window explicitly asking to open/switch repos) or, if none is
// given, into a freshly created window (CLI launch, dock drop, second
// instance — there's no "current" window to reuse).
async function openRepoDeduped(dir: string, currentState: WindowState | null): Promise<RepoInfo | null> {
  if (!(await gitlib.isRepo(dir))) {
    throw new Error(`Not a Git repository: ${dir}`);
  }
  const root = await gitlib.repoRoot(dir);
  const existing = windowForRepoRoot(root);
  if (existing && existing !== currentState?.win) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return null;
  }
  if (currentState) return openRepo(currentState, dir);
  // Register the reservation immediately (before the new window has even
  // loaded) so a second concurrent request for the same repo finds it
  // instead of racing to open a duplicate window.
  const state = createWindow(dir);
  repoWindows.set(root, state.win.id);
  return null;
}

function openRecentRepo(dir: string): void {
  const currentState = focusedState();
  openRepoDeduped(dir, currentState)
    .then((repo) => {
      buildMenu();
      if (repo && currentState && !currentState.win.isDestroyed()) {
        currentState.win.webContents.send('repo:opened', repo);
      }
    })
    .catch((err) => {
      const opts = {
        type: 'error' as const,
        message: 'Could not open repository',
        detail: err instanceof Error ? err.message : String(err),
      };
      const focused = BrowserWindow.getFocusedWindow();
      if (focused) dialog.showMessageBox(focused, opts);
      else dialog.showMessageBox(opts);
    });
}

// --------------------------------------------------------------------- ipc

function handle<T>(channel: string, fn: (state: WindowState, ...args: any[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const state = win && stateForWindow(win);
      if (!state) throw new Error('Window is closing');
      return { ok: true, value: await fn(state, ...args) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

handle('repo:openDialog', async (state): Promise<RepoInfo | null> => {
  const res = await dialog.showOpenDialog(state.win, {
    title: 'Open Git Repository',
    properties: ['openDirectory', 'showHiddenFiles'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const repo = await openRepoDeduped(res.filePaths[0]!, state);
  buildMenu();
  return repo;
});

handle('repo:open', async (state, dir: string): Promise<RepoInfo | null> => {
  const repo = await openRepoDeduped(dir, state);
  buildMenu();
  return repo;
});

handle('repo:last', async (state): Promise<RepoInfo | null> => {
  // Routed through the dedupe gate (not a bare `openRepo`) because the
  // resolved directory — pending, argv, or last-used — might already be
  // open in another window (e.g. "New Window" defaulting to the same
  // last-used repo as the window it was opened from).
  if (state.pendingRepoDir) {
    const dir = state.pendingRepoDir;
    state.pendingRepoDir = undefined;
    if (await gitlib.isRepo(dir)) return openRepoDeduped(dir, state);
  }
  const fromArgv = state.isPrimaryWindow ? argvRepo(process.argv) : null;
  if (fromArgv && (await gitlib.isRepo(fromArgv))) return openRepoDeduped(fromArgv, state);
  const { lastRepo } = loadSettings();
  if (lastRepo && (await gitlib.isRepo(lastRepo))) return openRepoDeduped(lastRepo, state);
  return null;
});

handle('git:status', (state) => gitlib.status(requireRepo(state)));
handle('git:diff', (state, relPath: string, type: gitlib.ChangeType, origPath: string | null) =>
  gitlib.fileDiff(requireRepo(state), relPath, type, origPath)
);
handle('git:commit', (state, { files, message, amend, partials }: CommitOptions) =>
  gitlib.commit(requireRepo(state), files, message, amend, partials || [])
);
handle('git:push', (state) => gitlib.push(requireRepo(state)));
handle('git:pull', (state) => gitlib.pull(requireRepo(state)));
handle('git:fetch', (state) => gitlib.fetch(requireRepo(state)));
handle('git:branches', (state) => gitlib.branches(requireRepo(state)));
handle('git:checkout', (state, name: string) => gitlib.checkout(requireRepo(state), name));
handle('git:createBranch', (state, name: string) => gitlib.createBranch(requireRepo(state), name));
handle('git:log', (state, opts: gitlib.LogOptions) => gitlib.log(requireRepo(state), opts || {}));
handle('git:commitDetails', (state, hash: string) => gitlib.commitDetails(requireRepo(state), hash));
handle('git:compareRefs', (state, refA: string, refB: string | null) =>
  gitlib.compareRefs(requireRepo(state), refA, refB)
);
handle(
  'git:refFileDiff',
  (state, refA: string, refB: string, relPath: string, type: gitlib.ChangeType, origPath: string | null) =>
    gitlib.refFileDiff(requireRepo(state), refA, refB, relPath, type, origPath)
);
handle(
  'git:imageData',
  (
    state,
    relPath: string,
    type: gitlib.ChangeType,
    origPath: string | null,
    leftRef?: string | null,
    rightRef?: string | null
  ) => gitlib.imageData(requireRepo(state), relPath, type, origPath, leftRef, rightRef)
);
handle('git:stashList', (state) => gitlib.stashList(requireRepo(state)));
handle('git:stashPush', (state, message?: string | null, includeUntracked?: boolean) =>
  gitlib.stashPush(requireRepo(state), message, includeUntracked)
);
handle('git:stashPop', (state, ref: string) => gitlib.stashPop(requireRepo(state), ref));
handle('git:stashApply', (state, ref: string) => gitlib.stashApply(requireRepo(state), ref));
handle('git:stashDrop', (state, ref: string) => gitlib.stashDrop(requireRepo(state), ref));
handle('git:blame', (state, relPath: string) => gitlib.blame(requireRepo(state), relPath));
handle('git:conflictInfo', (state, relPath: string) => gitlib.conflictInfo(requireRepo(state), relPath));
handle('git:markResolved', (state, relPath: string, content?: string | null) =>
  gitlib.markResolved(requireRepo(state), relPath, content)
);
handle('git:rollback', (state, files: RollbackTarget[]) =>
  gitlib.rollback(requireRepo(state), files as gitlib.FileEntry[])
);
handle('git:lastMessage', (state) => gitlib.lastCommitMessage(requireRepo(state)));
handle('git:commitTemplate', async (state): Promise<string> => {
  const root = requireRepo(state);
  try {
    const tpl = (await gitlib.git(root, ['config', '--get', 'commit.template'])).trim();
    if (!tpl) return '';
    const abs = tpl.startsWith('~')
      ? path.join(app.getPath('home'), tpl.slice(1))
      : path.resolve(root, tpl);
    return await fsp.readFile(abs, 'utf8');
  } catch {
    return '';
  }
});
handle('app:badge', (_state, count: number) => {
  try {
    app.setBadgeCount(Number(count) || 0);
  } catch {
    /* unsupported platform */
  }
});
handle('app:info', () => ({ name: app.name, version: app.getVersion() }));
handle('file:save', (state, relPath: string, content: string) =>
  gitlib.saveFile(requireRepo(state), relPath, content)
);
handle('settings:get', () => loadSettings());
handle('settings:set', (_state, patch: Partial<Settings>) => {
  const merged = saveSettings(patch);
  // Theme changes from the dialog must be reflected in the menu radios.
  if ('theme' in patch) buildMenu();
  return merged;
});
handle('keymap:set', (_state, overrides: keymap.KeymapOverrides) => {
  saveSettings({ keymap: overrides });
  buildMenu(); // menu accelerators must follow the new bindings
});
handle('shell:reveal', (state, relPath: string) =>
  shell.showItemInFolder(gitlib.insideRepo(requireRepo(state), relPath))
);
// Markdown-preview links. Only web URLs — anything else (file:, custom
// schemes) could invoke arbitrary local handlers.
handle('shell:openExternal', async (_state, url: string) => {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened');
  await shell.openExternal(url);
});
handle('app:confirm', async (state, { message, detail, confirmLabel }: ConfirmOptions): Promise<boolean> => {
  const res = await dialog.showMessageBox(state.win, {
    type: 'warning',
    buttons: [confirmLabel || 'OK', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message,
    detail,
  });
  return res.response === 0;
});

// -------------------------------------------------------------------- menu

function send(target: BrowserWindow | null, id: ActionId | `theme:${ThemeId}` | 'window-focus'): void {
  if (target && !target.isDestroyed()) target.webContents.send('menu', id);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const settings = loadSettings();
  const bindings = keymap.effective(settings.keymap || {});
  const currentTheme: ThemeId = THEMES[settings.theme as ThemeId] ? settings.theme! : DEFAULT_THEME;

  // Menu item for a rebindable action. When the binding converts to a menu
  // accelerator we attach it with registerAccelerator: false — on macOS the
  // menu consumes the keystroke (the renderer never sees it), on Linux/
  // Windows the renderer's keydown matcher handles it; exactly one handler
  // fires either way. Bindings that must stay renderer-only (Escape, bare
  // printable keys) get a label hint instead of an accelerator.
  const mi = (id: ActionId, label: string): MenuItemConstructorOptions => {
    const binding: Binding = bindings[id];
    const accelerator = keymap.toAccelerator(binding, process.platform);
    const item: MenuItemConstructorOptions = {
      label,
      click: () => send(BrowserWindow.getFocusedWindow(), id),
    };
    if (accelerator) {
      item.accelerator = accelerator;
      item.registerAccelerator = false;
    } else if (binding) {
      item.label = `${label} (${keymap.describe(binding, isMac)})`;
    }
    return item;
  };

  const recentRepos = settings.recentRepos || [];
  const recentRepoNames = recentRepos.map((dir) => dir.split(/[\\/]/).pop() || dir);
  const recentReposSubmenu: MenuItemConstructorOptions[] = recentRepos.length
    ? [
        ...recentRepos.map((dir, i): MenuItemConstructorOptions => {
          const name = recentRepoNames[i]!;
          const dupe = recentRepoNames.filter((n) => n === name).length > 1;
          return {
            label: dupe ? `${name} — ${dir}` : name,
            sublabel: isMac ? dir : undefined,
            toolTip: dir,
            click: () => openRecentRepo(dir),
          };
        }),
        { type: 'separator' },
        {
          label: 'Clear Recently Opened',
          click: () => {
            saveSettings({ recentRepos: [] });
            buildMenu();
          },
        },
      ]
    : [{ label: 'No Recent Repositories', enabled: false }];

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              mi('about-dialog', 'About Diffier'),
              { type: 'separator' },
              mi('keymap-settings', 'Settings…'),
              {
                label: 'Install Command Line Launcher…',
                click: () => installCliLauncher(),
              },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        mi('open-repo', 'Open Repository…'),
        { label: 'Open Recent', submenu: recentReposSubmenu },
        { label: 'New Window', click: () => createWindow() },
        { type: 'separator' },
        mi('save', 'Save'),
        ...(isMac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, mi('keymap-settings', 'Settings…')]),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Navigate',
      submenu: [
        mi('next-diff', 'Next Difference'),
        mi('prev-diff', 'Previous Difference'),
        { type: 'separator' },
        mi('next-file', 'Next Changed File'),
        mi('prev-file', 'Previous Changed File'),
        { type: 'separator' },
        mi('focus-tree', 'Focus Changes Tree'),
        mi('filter', 'Filter Changes'),
      ],
    },
    {
      label: 'Git',
      submenu: [
        mi('commit', 'Commit…'),
        mi('commit-execute', 'Commit Checked Files'),
        mi('commit-and-push', 'Commit and Push'),
        mi('commit-history', 'Commit Message History'),
        { type: 'separator' },
        mi('push', 'Push…'),
        mi('pull', 'Pull'),
        mi('fetch', 'Fetch'),
        { type: 'separator' },
        mi('branches', 'Branches…'),
        mi('stash', 'Stash / Unstash…'),
        { type: 'separator' },
        mi('rollback', 'Rollback…'),
        { type: 'separator' },
        mi('refresh', 'Refresh File Status'),
      ],
    },
    {
      label: 'View',
      submenu: [
        mi('toggle-panel', 'Commit Tool Window'),
        mi('toggle-log', 'Log Tool Window'),
        mi('annotate', 'Blame Annotations'),
        { type: 'separator' },
        mi('zoom-in', 'Zoom In'),
        mi('zoom-out', 'Zoom Out'),
        mi('zoom-reset', 'Reset Zoom'),
        {
          label: 'Theme',
          submenu: Object.values(THEMES).map((t) => ({
            label: t.label,
            type: 'radio' as const,
            checked: t.id === currentTheme,
            click: () => send(BrowserWindow.getFocusedWindow(), `theme:${t.id}`),
          })),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        ...BrowserWindow.getAllWindows().map((w): MenuItemConstructorOptions => {
          const state = stateForWindow(w);
          const root = state?.repoRoot;
          return {
            label: root ? path.basename(root) : 'Untitled',
            type: 'checkbox',
            checked: w === BrowserWindow.getFocusedWindow(),
            click: () => w.focus(),
          };
        }),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --------------------------------------------------------------- cli helper

// `diffier [dir]` from a terminal: a tiny launcher script that re-opens the
// app pointed at the given (or current) directory.
async function installCliLauncher(): Promise<void> {
  // Resolve to an absolute path in the caller's shell — the app's own cwd
  // is / when launched via `open`, so relative arguments would be useless.
  const script = `#!/bin/sh\ntarget="$(cd "\${1:-.}" 2>/dev/null && pwd)" || {\n  echo "diffier: no such directory: \${1:-.}" >&2\n  exit 1\n}\nexec open -n -a "Diffier" --args "$target"\n`;
  const target = '/usr/local/bin/diffier';
  const parent = BrowserWindow.getFocusedWindow();
  const show = (opts: Electron.MessageBoxOptions) =>
    parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts);
  try {
    await fsp.writeFile(target, script, { mode: 0o755 });
    show({
      type: 'info',
      message: 'Command line launcher installed',
      detail: `${target} — run "diffier ." in any repository.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    show({
      type: 'error',
      message: 'Could not install the launcher',
      detail:
        `${message}\n\nInstall it manually:\n` +
        `printf '${script.replace(/\n/g, '\\n')}' | sudo tee ${target} && sudo chmod +x ${target}`,
    });
  }
}

// A directory passed on the command line (e.g. via the `diffier` launcher or
// `electron . /path/to/repo`) wins over the last-opened repository.
function argvRepo(argv: string[], cwd: string = process.cwd()): string | null {
  for (const arg of argv.slice(1).reverse()) {
    if (arg.startsWith('-')) continue;
    try {
      const abs = path.resolve(cwd, arg);
      // Skip the app-path argument from `electron .` in development.
      if (abs === app.getAppPath()) continue;
      if (fs.statSync(abs).isDirectory()) return abs;
    } catch {
      /* not a directory */
    }
  }
  return null;
}

// ------------------------------------------------------------------ window

const APP_ICON = path.join(__dirname, '..', 'build', 'icon.png');

// `pendingRepoDir` is consulted by the `repo:last` handler once this
// window's renderer boots — used for windows created to point at a known
// repo (CLI/dock/second-instance/"Open Recent"). `isPrimaryWindow` is only
// ever true for the first window of the process, the one allowed to fall
// back to `process.argv` when it has no pending repo of its own.
function createWindow(pendingRepoDir?: string, isPrimaryWindow = false): WindowState {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#101113',
    icon: APP_ICON,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const state: WindowState = {
    win,
    repoRoot: null,
    watcher: null,
    watchTimer: undefined,
    pendingRepoDir,
    isPrimaryWindow,
  };
  windowStates.set(win.id, state);

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('focus', () => send(win, 'window-focus'));
  win.on('closed', () => {
    stopWatching(state);
    // Scan by window id rather than `state.repoRoot` — a window created for
    // a pending repo (see `openRepoDeduped`) is reserved in `repoWindows`
    // before its own boot has run `openRepo` to set `state.repoRoot`, so it
    // could be closed in between with the field still null.
    for (const [root, id] of repoWindows) {
      if (id === win.id) repoWindows.delete(root);
    }
    windowStates.delete(win.id);
    buildMenu(); // Window menu's window list must drop the closed entry
  });

  // The renderer never legitimately navigates away from index.html or opens
  // new windows — deny both outright rather than trusting content it renders
  // (commit messages, branch names, file contents) not to contain a link.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Electron ships no native context menu — build a minimal edit menu so
  // right-click Copy/Cut/Paste works anywhere text can be selected/edited.
  win.webContents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      items.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll }
      );
    } else if (params.selectionText) {
      items.push({ role: 'copy' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup();
  });

  buildMenu(); // Window menu's window list must include the new entry
  return state;
}

// ------------------------------------------------------------------- smoke
// DIFFIER_SMOKE=1 runs the app headless-ish: load the UI against the repo in
// DIFFIER_SMOKE_REPO, collect renderer console output for a few seconds and
// exit non-zero on any renderer error. Used by CI / development on Linux.

function runSmoke(): void {
  const errors: string[] = [];
  const logs: string[] = [];
  app.whenReady().then(async () => {
    buildMenu();
    const state = createWindow(undefined, true);
    if (process.env.DIFFIER_SMOKE_REPO) {
      try {
        await openRepo(state, process.env.DIFFIER_SMOKE_REPO);
      } catch (e) {
        errors.push('openRepo failed: ' + (e instanceof Error ? e.message : String(e)));
      }
    }
    const win = state.win;
    win.webContents.on('console-message', (_e, level, message, _line, sourceId) => {
      logs.push(`[console:${level}] ${message}`);
      // Benign: monaco intentionally falls back to main-thread diffing when
      // workers can't be created from file://, and the optional shiki bundle
      // may not have been built (app falls back to Monarch grammars).
      const benign =
        /worker|falling back/i.test(message) ||
        /highlighter\.js/.test(message) ||
        /highlighter\.js/.test(sourceId || '');
      if (level >= 3 && !benign) errors.push(message);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      errors.push('renderer gone: ' + details.reason);
    });
    win.webContents.on(
      'did-fail-load',
      (_e, code, desc) => errors.push(`did-fail-load ${code} ${desc}`)
    );
    setTimeout(() => {
      logs.forEach((l) => console.log(l));
      if (errors.length) {
        console.error('SMOKE FAILED:\n' + errors.join('\n'));
        app.exit(1);
      } else {
        console.log('SMOKE OK');
        app.exit(0);
      }
    }, 8000);
  });
}

// -------------------------------------------------------------------- boot

// One repo per window, so an external "open this directory" request (CLI
// launcher, dock drop, Finder "Open With") either focuses the window that
// already has it open or creates a new one — it never reuses a window that
// has a *different* repo open, and never opens a duplicate.
function routeExternalOpen(dir: string): void {
  openRepoDeduped(dir, null)
    .then(() => buildMenu())
    .catch((err) => {
      dialog.showErrorBox('Could not open repository', err instanceof Error ? err.message : String(err));
    });
}

if (SMOKE) {
  runSmoke();
} else {
  // Only one OS process at a time: a second `diffier <dir>` invocation (or a
  // second `open -a Diffier`) hands its argv to the already-running instance
  // via 'second-instance' below and then quits itself.
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', (_event, argv, workingDirectory) => {
      const dir = argvRepo(argv, workingDirectory);
      if (dir) {
        routeExternalOpen(dir);
        return;
      }
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });

    // Folders dropped on the dock icon / opened via `open -a Diffier <dir>`.
    // On a cold launch this fires before 'ready', so queue it — otherwise the
    // request is dropped and the default window opens the last-used repo
    // instead.
    const pendingOpenFiles: string[] = [];
    app.on('open-file', (event, p) => {
      event.preventDefault();
      if (app.isReady()) routeExternalOpen(p);
      else pendingOpenFiles.push(p);
    });

    app.whenReady().then(() => {
      // Packaged mac builds get their dock icon from the bundled .icns; in
      // dev (`electron .`) it otherwise falls back to Electron's own.
      if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(APP_ICON);
      buildMenu();
      if (pendingOpenFiles.length) {
        pendingOpenFiles.forEach(routeExternalOpen);
      } else {
        createWindow(undefined, true);
      }
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    });
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || SMOKE) app.quit();
});
