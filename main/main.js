'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const gitlib = require('./git');
const keymap = require('./keymap');
const { THEMES, DEFAULT_THEME } = require('./themes');

const SMOKE = process.env.DIFFIER_SMOKE === '1';

let win = null;
let repoRoot = null;
let watcher = null;
let watchTimer = null;

// ---------------------------------------------------------------- settings

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(patch) {
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

function stopWatching() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

function startWatching(root) {
  stopWatching();
  try {
    watcher = fs.watch(root, { recursive: true }, (event, filename) => {
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

async function openRepo(dir) {
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

function requireRepo() {
  if (!repoRoot) throw new Error('No repository is open');
  return repoRoot;
}

// --------------------------------------------------------------------- ipc

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

handle('repo:openDialog', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open Git Repository',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return openRepo(res.filePaths[0]);
});

handle('repo:open', (dir) => openRepo(dir));

handle('repo:last', async () => {
  const fromArgv = argvRepo(process.argv);
  if (fromArgv && (await gitlib.isRepo(fromArgv))) return openRepo(fromArgv);
  const { lastRepo } = loadSettings();
  if (lastRepo && (await gitlib.isRepo(lastRepo))) return openRepo(lastRepo);
  return null;
});

handle('git:status', () => gitlib.status(requireRepo()));
handle('git:diff', (relPath, type, origPath) =>
  gitlib.fileDiff(requireRepo(), relPath, type, origPath)
);
handle('git:commit', ({ files, message, amend, partials }) =>
  gitlib.commit(requireRepo(), files, message, amend, partials || [])
);
handle('git:push', () => gitlib.push(requireRepo()));
handle('git:pull', () => gitlib.pull(requireRepo()));
handle('git:fetch', () => gitlib.fetch(requireRepo()));
handle('git:branches', () => gitlib.branches(requireRepo()));
handle('git:checkout', (name) => gitlib.checkout(requireRepo(), name));
handle('git:createBranch', (name) => gitlib.createBranch(requireRepo(), name));
handle('git:log', (opts) => gitlib.log(requireRepo(), opts || {}));
handle('git:commitDetails', (hash) => gitlib.commitDetails(requireRepo(), hash));
handle('git:commitFileDiff', (hash, relPath, type, origPath, ref2) =>
  gitlib.commitFileDiff(requireRepo(), hash, relPath, type, origPath, ref2)
);
handle('git:stashList', () => gitlib.stashList(requireRepo()));
handle('git:stashPush', (message, includeUntracked) =>
  gitlib.stashPush(requireRepo(), message, includeUntracked)
);
handle('git:stashPop', (ref) => gitlib.stashPop(requireRepo(), ref));
handle('git:stashApply', (ref) => gitlib.stashApply(requireRepo(), ref));
handle('git:stashDrop', (ref) => gitlib.stashDrop(requireRepo(), ref));
handle('git:blame', (relPath) => gitlib.blame(requireRepo(), relPath));
handle('git:conflictInfo', (relPath) => gitlib.conflictInfo(requireRepo(), relPath));
handle('git:markResolved', (relPath, content) =>
  gitlib.markResolved(requireRepo(), relPath, content)
);
handle('git:rollback', (files) => gitlib.rollback(requireRepo(), files));
handle('git:lastMessage', () => gitlib.lastCommitMessage(requireRepo()));
handle('git:commitTemplate', async () => {
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
handle('app:badge', (count) => {
  try {
    app.setBadgeCount(Number(count) || 0);
  } catch {
    /* unsupported platform */
  }
});
handle('file:save', (relPath, content) => gitlib.saveFile(requireRepo(), relPath, content));
handle('settings:get', () => loadSettings());
handle('settings:set', (patch) => {
  const merged = saveSettings(patch);
  // Theme changes from the dialog must be reflected in the menu radios.
  if ('theme' in patch) buildMenu();
  return merged;
});
handle('keymap:set', (overrides) => {
  saveSettings({ keymap: overrides });
  buildMenu(); // menu accelerators must follow the new bindings
});
handle('shell:reveal', (relPath) =>
  shell.showItemInFolder(path.join(requireRepo(), relPath))
);
handle('app:confirm', async ({ message, detail, confirmLabel }) => {
  const res = await dialog.showMessageBox(win, {
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

function send(id) {
  if (win && !win.isDestroyed()) win.webContents.send('menu', id);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const settings = loadSettings();
  const bindings = keymap.effective(settings.keymap || {});
  const currentTheme = THEMES[settings.theme] ? settings.theme : DEFAULT_THEME;

  // Menu item for a rebindable action. When the binding converts to a menu
  // accelerator we attach it with registerAccelerator: false — on macOS the
  // menu consumes the keystroke (the renderer never sees it), on Linux/
  // Windows the renderer's keydown matcher handles it; exactly one handler
  // fires either way. Bindings that must stay renderer-only (Escape, bare
  // printable keys) get a label hint instead of an accelerator.
  const mi = (id, label) => {
    const binding = bindings[id];
    const accelerator = keymap.toAccelerator(binding, process.platform);
    const item = { label, click: () => send(id) };
    if (accelerator) {
      item.accelerator = accelerator;
      item.registerAccelerator = false;
    } else if (binding) {
      item.label = `${label} (${keymap.describe(binding, isMac)})`;
    }
    return item;
  };

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
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
        ]
      : []),
    {
      label: 'File',
      submenu: [
        mi('open-repo', 'Open Repository…'),
        { type: 'separator' },
        mi('save', 'Save'),
        ...(isMac ? [] : [{ type: 'separator' }, mi('keymap-settings', 'Settings…')]),
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
            type: 'radio',
            checked: t.id === currentTheme,
            click: () => send('theme:' + t.id),
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
async function installCliLauncher() {
  const script = `#!/bin/sh\nexec open -a "Diffier" --args "\${1:-$PWD}"\n`;
  const target = '/usr/local/bin/diffier';
  try {
    await fsp.writeFile(target, script, { mode: 0o755 });
    dialog.showMessageBox(win, {
      type: 'info',
      message: 'Command line launcher installed',
      detail: `${target} — run "diffier ." in any repository.`,
    });
  } catch (err) {
    dialog.showMessageBox(win, {
      type: 'error',
      message: 'Could not install the launcher',
      detail:
        `${err.message}\n\nInstall it manually:\n` +
        `printf '${script.replace(/\n/g, '\\n')}' | sudo tee ${target} && sudo chmod +x ${target}`,
    });
  }
}

// A directory passed on the command line (e.g. via the `diffier` launcher or
// `electron . /path/to/repo`) wins over the last-opened repository.
function argvRepo(argv) {
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

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#101113',
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
}

// ------------------------------------------------------------------- smoke
// DIFFIER_SMOKE=1 runs the app headless-ish: load the UI against the repo in
// DIFFIER_SMOKE_REPO, collect renderer console output for a few seconds and
// exit non-zero on any renderer error. Used by CI / development on Linux.

function runSmoke() {
  const errors = [];
  const logs = [];
  app.whenReady().then(async () => {
    if (process.env.DIFFIER_SMOKE_REPO) {
      try {
        await openRepo(process.env.DIFFIER_SMOKE_REPO);
      } catch (e) {
        errors.push('openRepo failed: ' + e.message);
      }
    }
    buildMenu();
    createWindow();
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
