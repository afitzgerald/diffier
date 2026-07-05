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

let win: BrowserWindow | null = null;
let repoRoot: string | null = null;
let watcher: fs.FSWatcher | null = null;
let watchTimer: ReturnType<typeof setTimeout> | undefined;

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

function stopWatching(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

function startWatching(root: string): void {
  stopWatching();
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
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
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.send('repo:changed');
      }, 400);
    });
  } catch {
    // Recursive fs.watch unavailable — the renderer also refreshes on focus.
  }
}

// -------------------------------------------------------------------- repo

async function openRepo(dir: string): Promise<RepoInfo> {
  if (!(await gitlib.isRepo(dir))) {
    throw new Error(`Not a Git repository: ${dir}`);
  }
  repoRoot = await gitlib.repoRoot(dir);
  startWatching(repoRoot);
  const recents = [
    repoRoot,
    ...(loadSettings().recentRepos || []).filter((r) => r !== repoRoot),
  ].slice(0, 10);
  saveSettings({ lastRepo: repoRoot, recentRepos: recents });
  return {
    root: repoRoot,
    name: path.basename(repoRoot),
    isWorktree: await gitlib.isLinkedWorktree(repoRoot),
    recents,
  };
}

function requireRepo(): string {
  if (!repoRoot) throw new Error('No repository is open');
  return repoRoot;
}

function openRecentRepo(dir: string): void {
  openRepo(dir)
    .then((repo) => {
      buildMenu();
      if (win && !win.isDestroyed()) win.webContents.send('repo:opened', repo);
    })
    .catch((err) => {
      dialog.showMessageBox(win!, {
        type: 'error',
        message: 'Could not open repository',
        detail: err instanceof Error ? err.message : String(err),
      });
    });
}

// --------------------------------------------------------------------- ipc

function handle<T>(channel: string, fn: (...args: any[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

handle('repo:openDialog', async (): Promise<RepoInfo | null> => {
  const res = await dialog.showOpenDialog(win!, {
    title: 'Open Git Repository',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return openRepo(res.filePaths[0]!);
});

handle('repo:open', (dir: string) => openRepo(dir));

handle('repo:last', async (): Promise<RepoInfo | null> => {
  const fromArgv = argvRepo(process.argv);
  if (fromArgv && (await gitlib.isRepo(fromArgv))) return openRepo(fromArgv);
  const { lastRepo } = loadSettings();
  if (lastRepo && (await gitlib.isRepo(lastRepo))) return openRepo(lastRepo);
  return null;
});

handle('git:status', () => gitlib.status(requireRepo()));
handle('git:diff', (relPath: string, type: gitlib.ChangeType, origPath: string | null) =>
  gitlib.fileDiff(requireRepo(), relPath, type, origPath)
);
handle('git:commit', ({ files, message, amend, partials }: CommitOptions) =>
  gitlib.commit(requireRepo(), files, message, amend, partials || [])
);
handle('git:push', () => gitlib.push(requireRepo()));
handle('git:pull', () => gitlib.pull(requireRepo()));
handle('git:fetch', () => gitlib.fetch(requireRepo()));
handle('git:branches', () => gitlib.branches(requireRepo()));
handle('git:checkout', (name: string) => gitlib.checkout(requireRepo(), name));
handle('git:createBranch', (name: string) => gitlib.createBranch(requireRepo(), name));
handle('git:log', (opts: gitlib.LogOptions) => gitlib.log(requireRepo(), opts || {}));
handle('git:commitDetails', (hash: string) => gitlib.commitDetails(requireRepo(), hash));
handle(
  'git:commitFileDiff',
  (hash: string, relPath: string, type: gitlib.ChangeType, origPath: string | null, ref2?: string | null) =>
    gitlib.commitFileDiff(requireRepo(), hash, relPath, type, origPath, ref2)
);
handle(
  'git:imageData',
  (relPath: string, type: gitlib.ChangeType, origPath: string | null, hash?: string | null) =>
    gitlib.imageData(requireRepo(), relPath, type, origPath, hash)
);
handle('git:stashList', () => gitlib.stashList(requireRepo()));
handle('git:stashPush', (message?: string | null, includeUntracked?: boolean) =>
  gitlib.stashPush(requireRepo(), message, includeUntracked)
);
handle('git:stashPop', (ref: string) => gitlib.stashPop(requireRepo(), ref));
handle('git:stashApply', (ref: string) => gitlib.stashApply(requireRepo(), ref));
handle('git:stashDrop', (ref: string) => gitlib.stashDrop(requireRepo(), ref));
handle('git:blame', (relPath: string) => gitlib.blame(requireRepo(), relPath));
handle('git:conflictInfo', (relPath: string) => gitlib.conflictInfo(requireRepo(), relPath));
handle('git:markResolved', (relPath: string, content?: string | null) =>
  gitlib.markResolved(requireRepo(), relPath, content)
);
handle('git:rollback', (files: RollbackTarget[]) => gitlib.rollback(requireRepo(), files as gitlib.FileEntry[]));
handle('git:lastMessage', () => gitlib.lastCommitMessage(requireRepo()));
handle('git:commitTemplate', async (): Promise<string> => {
  const root = requireRepo();
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
handle('app:badge', (count: number) => {
  try {
    app.setBadgeCount(Number(count) || 0);
  } catch {
    /* unsupported platform */
  }
});
handle('app:info', () => ({ name: app.name, version: app.getVersion() }));
handle('file:save', (relPath: string, content: string) => gitlib.saveFile(requireRepo(), relPath, content));
handle('settings:get', () => loadSettings());
handle('settings:set', (patch: Partial<Settings>) => {
  const merged = saveSettings(patch);
  // Theme changes from the dialog must be reflected in the menu radios.
  if ('theme' in patch) buildMenu();
  return merged;
});
handle('keymap:set', (overrides: keymap.KeymapOverrides) => {
  saveSettings({ keymap: overrides });
  buildMenu(); // menu accelerators must follow the new bindings
});
handle('shell:reveal', (relPath: string) =>
  shell.showItemInFolder(gitlib.insideRepo(requireRepo(), relPath))
);
// Markdown-preview links. Only web URLs — anything else (file:, custom
// schemes) could invoke arbitrary local handlers.
handle('shell:openExternal', async (url: string) => {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened');
  await shell.openExternal(url);
});
handle('app:confirm', async ({ message, detail, confirmLabel }: ConfirmOptions): Promise<boolean> => {
  const res = await dialog.showMessageBox(win!, {
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

function send(id: ActionId | `theme:${ThemeId}` | 'window-focus'): void {
  if (win && !win.isDestroyed()) win.webContents.send('menu', id);
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
    const item: MenuItemConstructorOptions = { label, click: () => send(id) };
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
        {
          label: 'Theme',
          submenu: Object.values(THEMES).map((t) => ({
            label: t.label,
            type: 'radio' as const,
            checked: t.id === currentTheme,
            click: () => send(`theme:${t.id}`),
          })),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }],
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
  const script = `#!/bin/sh\ntarget="$(cd "\${1:-.}" 2>/dev/null && pwd)" || {\n  echo "diffier: no such directory: \${1:-.}" >&2\n  exit 1\n}\nexec open -a "Diffier" --args "$target"\n`;
  const target = '/usr/local/bin/diffier';
  try {
    await fsp.writeFile(target, script, { mode: 0o755 });
    dialog.showMessageBox(win!, {
      type: 'info',
      message: 'Command line launcher installed',
      detail: `${target} — run "diffier ." in any repository.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dialog.showMessageBox(win!, {
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
function argvRepo(argv: string[]): string | null {
  for (const arg of argv.slice(1).reverse()) {
    if (arg.startsWith('-')) continue;
    try {
      const abs = path.resolve(arg);
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

function createWindow(): void {
  win = new BrowserWindow({
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
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('focus', () => send('window-focus'));

  // The renderer never legitimately navigates away from index.html or opens
  // new windows — deny both outright rather than trusting content it renders
  // (commit messages, branch names, file contents) not to contain a link.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// ------------------------------------------------------------------- smoke
// DIFFIER_SMOKE=1 runs the app headless-ish: load the UI against the repo in
// DIFFIER_SMOKE_REPO, collect renderer console output for a few seconds and
// exit non-zero on any renderer error. Used by CI / development on Linux.

function runSmoke(): void {
  const errors: string[] = [];
  const logs: string[] = [];
  app.whenReady().then(async () => {
    if (process.env.DIFFIER_SMOKE_REPO) {
      try {
        await openRepo(process.env.DIFFIER_SMOKE_REPO);
      } catch (e) {
        errors.push('openRepo failed: ' + (e instanceof Error ? e.message : String(e)));
      }
    }
    buildMenu();
    createWindow();
    win!.webContents.on('console-message', (_e, level, message, _line, sourceId) => {
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
    win!.webContents.on('render-process-gone', (_e, details) => {
      errors.push('renderer gone: ' + details.reason);
    });
    win!.webContents.on(
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

if (SMOKE) {
  runSmoke();
} else {
  // Folders dropped on the dock icon / opened via `open -a Diffier <dir>`.
  app.on('open-file', (event, p) => {
    event.preventDefault();
    openRepo(p)
      .then((repo) => {
        if (win && !win.isDestroyed()) win.webContents.send('repo:opened', repo);
      })
      .catch(() => {});
  });
  app.whenReady().then(() => {
    // Packaged mac builds get their dock icon from the bundled .icns; in dev
    // (`electron .`) it otherwise falls back to Electron's own.
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(APP_ICON);
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  stopWatching();
  if (process.platform !== 'darwin' || SMOKE) app.quit();
});
