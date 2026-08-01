'use strict';

/*
 * End-to-end UI test. Electron binaries can't be downloaded in every
 * environment, but the renderer talks to the main process exclusively via
 * `window.api`, so we serve the renderer over HTTP, shim `window.api` with
 * fetch calls to a tiny RPC server backed by the real main/git.ts, and drive
 * the UI with Playwright + the preinstalled Chromium.
 */

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { Page } from 'playwright-core';
import * as gitlib from '../main/git';
import * as keymapLib from '../main/keymap';
import * as themesLib from '../main/themes';

// The `page.evaluate()` closures below run inside the browser page, not in
// this Node process — `monaco` is a real global there (set up by
// renderer/index.html's AMD loader), but it isn't part of this program, so
// it's declared loosely here purely to satisfy the compiler.
declare const monaco: {
  editor: {
    getModels(): { getLanguageId(): string }[];
    colorize(text: string, languageId: string, options: unknown): Promise<string>;
  };
};

// renderer/languages.ts is a classic global script (no import/export) built
// around the ambient `monaco` global — it isn't part of this Node-context
// program, so require() the compiled output and type only what's used here.
interface LanguagesApi {
  SHIKI_LANGUAGES: { id: string }[];
}
const languagesLib = require('../renderer/languages') as LanguagesApi;

declare global {
  interface Window {
    __pos?: () => boolean;
    __shikiActive?: boolean;
    __mdPwned?: boolean;
    __copiedText?: string;
  }
}

const ROOT = path.join(__dirname, '..');

// ------------------------------------------------------------- test repo

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'diffier-ui-'));
const g = (...args: string[]): string => execFileSync('git', args, { cwd: repo }).toString();

g('init', '-b', 'main');
g('config', 'user.email', 't@t.local');
g('config', 'user.name', 'T');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(
  path.join(repo, 'src/alpha.js'),
  'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n\nfunction c() {\n  return 3;\n}\n'
);
fs.writeFileSync(path.join(repo, 'src/beta.js'), 'const x = 1;\n');
g('add', '-A');
g('commit', '-m', 'seed');

// Two separated changes in alpha.js (two diff hunks), one change in beta.js,
// plus an untracked file.
fs.writeFileSync(
  path.join(repo, 'src/alpha.js'),
  'function a() {\n  return 100;\n}\n\nfunction b() {\n  return 2;\n}\n\nfunction c() {\n  return 300;\n}\n'
);
fs.writeFileSync(path.join(repo, 'src/beta.js'), 'const x = 42;\n');
fs.writeFileSync(path.join(repo, 'notes.txt'), 'untracked\n');

// ------------------------------------------------------------ rpc backend

interface CommitArgs {
  files: string[];
  message: string;
  amend: boolean;
  partials?: { path: string; content: string }[];
}

const settings: { lastRepo: string; keymap?: unknown; theme?: string; panelSide?: string } = {
  lastRepo: repo,
};

const rpc: Record<string, (args: unknown[]) => Promise<unknown>> = {
  'repo:last': async () => ({
    root: repo,
    name: path.basename(repo),
    isWorktree: false,
    recents: [repo],
  }),
  'repo:open': async ([dir]) => ({
    root: dir,
    name: path.basename(dir as string),
    isWorktree: false,
    recents: [dir],
  }),
  'git:status': () => gitlib.status(repo),
  'git:diff': ([p, t, o]) => gitlib.fileDiff(repo, p as string, t as gitlib.ChangeType, o as string | null),
  'git:commit': ([opts]) => {
    const { files, message, amend, partials } = opts as CommitArgs;
    return gitlib.commit(repo, files, message, amend, partials || []);
  },
  'git:rollback': ([files]) => gitlib.rollback(repo, files as gitlib.FileEntry[]),
  'git:lastMessage': () => gitlib.lastCommitMessage(repo),
  'git:push': () => gitlib.push(repo),
  'git:pull': () => gitlib.pull(repo),
  'git:fetch': () => gitlib.fetch(repo),
  'git:branches': () => gitlib.branches(repo),
  'git:checkout': ([name]) => gitlib.checkout(repo, name as string),
  'git:createBranch': ([name]) => gitlib.createBranch(repo, name as string),
  'git:log': ([opts]) => gitlib.log(repo, (opts as gitlib.LogOptions) || {}),
  'git:commitDetails': ([hash]) => gitlib.commitDetails(repo, hash as string),
  'git:compareRefs': ([refA, refB]) => gitlib.compareRefs(repo, refA as string, refB as string | null),
  'git:refFileDiff': ([refA, refB, p, t, o]) =>
    gitlib.refFileDiff(repo, refA as string, refB as string, p as string, t as gitlib.ChangeType, o as string | null),
  'git:imageData': ([p, t, o, leftRef, rightRef]) =>
    gitlib.imageData(repo, p as string, t as gitlib.ChangeType, o as string | null, leftRef as string | null, rightRef as string | null),
  'git:stashList': () => gitlib.stashList(repo),
  'git:stashPush': ([msg, untracked]) => gitlib.stashPush(repo, msg as string, untracked as boolean),
  'git:stashPop': ([ref]) => gitlib.stashPop(repo, ref as string),
  'git:stashApply': ([ref]) => gitlib.stashApply(repo, ref as string),
  'git:stashDrop': ([ref]) => gitlib.stashDrop(repo, ref as string),
  'git:blame': ([p]) => gitlib.blame(repo, p as string),
  'git:conflictInfo': ([p]) => gitlib.conflictInfo(repo, p as string),
  'git:markResolved': ([p, c]) => gitlib.markResolved(repo, p as string, c as string),
  'git:commitTemplate': async () => '',
  'app:badge': async () => null,
  'app:info': async () => ({ name: 'Diffier', version: '0.0.0-test' }),
  'file:save': ([p, c]) => gitlib.saveFile(repo, p as string, c as string),
  'settings:get': async () => settings,
  'settings:set': async ([patch]) => Object.assign(settings, patch),
  'keymap:set': async ([overrides]) => {
    settings.keymap = overrides;
  },
  'app:confirm': async () => true,
  'shell:openExternal': async ([url]) => {
    openedExternally.push(url as string);
    return null;
  },
  'shell:reveal': async ([p]) => {
    revealedPaths.push(p as string);
    return null;
  },
};

// URLs the renderer asked the OS to open (markdown-preview links).
const openedExternally: string[] = [];
// Paths the renderer asked the OS to reveal in Finder (context-menu action).
const revealedPaths: string[] = [];

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/rpc') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const { method, args } = JSON.parse(body);
      try {
        const fn = rpc[method];
        if (!fn) throw new Error('no rpc method ' + method);
        const value = await fn(args || []);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, value: value === undefined ? null : value }));
      } catch (err) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      }
    });
    return;
  }
  const rel = decodeURIComponent((req.url || '').split('?')[0]!);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found: ' + rel);
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ----------------------------------------------------------------- shim

const API_SHIM = `
  window.api = new Proxy({}, {
    get(_, name) {
      const channels = {
        openLastRepo: 'repo:last', openRepo: 'repo:open', gitStatus: 'git:status',
        gitDiff: 'git:diff', gitCommit: 'git:commit', gitPush: 'git:push',
        gitPull: 'git:pull', gitFetch: 'git:fetch', gitBranches: 'git:branches',
        gitCheckout: 'git:checkout', gitCreateBranch: 'git:createBranch',
        gitLog: 'git:log', gitCommitDetails: 'git:commitDetails',
        gitCompareRefs: 'git:compareRefs', gitRefFileDiff: 'git:refFileDiff',
        gitImageData: 'git:imageData',
        gitStashList: 'git:stashList',
        gitStashPush: 'git:stashPush', gitStashPop: 'git:stashPop',
        gitStashApply: 'git:stashApply', gitStashDrop: 'git:stashDrop',
        gitBlame: 'git:blame', gitConflictInfo: 'git:conflictInfo',
        gitMarkResolved: 'git:markResolved', gitCommitTemplate: 'git:commitTemplate',
        setBadge: 'app:badge', getAppInfo: 'app:info', gitRollback: 'git:rollback',
        gitLastMessage: 'git:lastMessage', saveFile: 'file:save',
        getSettings: 'settings:get', setSettings: 'settings:set',
        confirm: 'app:confirm', revealFile: 'shell:reveal', setKeymap: 'keymap:set',
        openExternal: 'shell:openExternal',
      };
      if (name === 'keymapActions') return ${JSON.stringify(keymapLib.ACTIONS)};
      if (name === 'themes') return ${JSON.stringify(themesLib.THEMES)};
      if (name === 'defaultTheme') return ${JSON.stringify(themesLib.DEFAULT_THEME)};
      if (name === 'onMenu' || name === 'onRepoChanged' || name === 'onRepoOpened') return () => {};
      if (name === 'openRepoDialog') return async () => null;
      const ch = channels[name];
      return async (...args) => {
        const res = await fetch('/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method: ch, args }),
        }).then((r) => r.json());
        if (!res.ok) throw new Error(res.error);
        return res.value;
      };
    },
  });
`;

// ------------------------------------------------------------------ test

async function main(): Promise<void> {
  const { chromium } = await import('playwright-core');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}/renderer/index.html`;

  const browser = await chromium.launch({
    executablePath: process.env.DIFFIER_CHROMIUM || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });
  const page: Page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/worker|falling back/i.test(msg.text())) {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  // Pin a non-mac platform so keymap "Mod" resolves to Ctrl regardless of the
  // host OS — the shortcut steps below press Control+… and expect "Ctrl+…" labels.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' });
  });
  await page.addInitScript(API_SHIM);
  // Chromium's real clipboard needs a permission grant we don't otherwise
  // set up; stub it so "Copy Path" context-menu items are observable.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (t: string) => {
          window.__copiedText = t;
          return Promise.resolve();
        },
      },
    });
  });
  // The assertions assume non-mac key semantics (Mod = Ctrl); pin
  // navigator.platform so the suite also passes on a macOS dev machine.
  await page.addInitScript(
    "Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' });"
  );
  await page.goto(url);

  const expect = async (desc: string, fn: () => Promise<unknown>, timeout = 10000): Promise<unknown> => {
    const start = Date.now();
    for (;;) {
      try {
        const v = await fn();
        if (v) {
          console.log('  ok:', desc);
          return v;
        }
      } catch {
        /* retry */
      }
      if (Date.now() - start > timeout) {
        try {
          console.log(
            'DEBUG on failure — toast:',
            JSON.stringify(await page.locator('#toast').textContent()),
            'file:',
            JSON.stringify(await page.locator('#diff-file-path').textContent()),
            'consoleErrors:',
            consoleErrors
          );
        } catch {
          /* best effort */
        }
        throw new Error('FAILED: ' + desc);
      }
      await page.waitForTimeout(150);
    }
  };

  // --- tree renders all changed files, auto-selects the first one
  await expect('3 changed files in tree', async () =>
    (await page.locator('#tree .tree-row[data-key^="file:"]').count()) === 3);
  await expect('branch shown in status bar', async () =>
    (await page.locator('#status-branch').textContent()) === 'main');
  // Directories sort before root-level files, so src/alpha.js is first.
  await expect('first file auto-opened in diff', async () =>
    (await page.locator('#diff-file-path').textContent()) === 'src/alpha.js');
  await expect('unversioned file colored red', async () =>
    (await page.locator('.file-name.UNVERSIONED').count()) >= 1);
  await expect('modified file colored blue', async () =>
    (await page.locator('.file-name.MODIFIED').count()) >= 1);

  // --- monaco renders content
  await expect('monaco shows file content', async () =>
    (await page.locator('#diff-editor .view-line').count()) > 0);

  // --- click alpha.js, verify diff count reflects two hunks
  await page.locator('.tree-row[data-key="file:src/alpha.js"]').click();
  await expect('alpha.js open', async () =>
    (await page.locator('#diff-file-path').textContent()) === 'src/alpha.js');
  await expect('2 differences reported', async () =>
    (await page.locator('#diff-count').textContent()) === '2 differences');

  // --- F7 navigation: first change → second change → armed toast → next file
  const line = async (): Promise<boolean | undefined> =>
    page.evaluate(() => window.__pos && window.__pos());
  await page.evaluate(() => {
    // expose cursor position for assertions
    window.__pos = () => {
      const sel = document.querySelector('#diff-editor');
      return sel ? true : false;
    };
  });

  const press = async (key: string): Promise<void> => {
    await page.keyboard.press(key);
    await page.waitForTimeout(400); // human-paced; file switches are async
  };

  // openDiff's once-only onDidUpdateDiff handler can race Monaco's first
  // (still-empty) diff update on slower machines, leaving the cursor at 1:1
  // instead of on the first change. Pin it explicitly so the F7 walk always
  // starts from a known spot.
  await page.evaluate(() => {
    const w = window as unknown as {
      getLineChanges(): unknown[];
      gotoChange(c: unknown): void;
    };
    w.gotoChange(w.getLineChanges()[0]);
  });
  await press('F7'); // to second hunk (cursor starts at first)
  await press('F7'); // at last difference → arms the next-file hint
  await expect('F7 arms next-file toast at last difference', async () =>
    /next file/i.test((await page.locator('#toast').textContent()) || ''));
  await press('F7'); // armed → jump to next file
  await expect('second F7 moves to next changed file', async () =>
    (await page.locator('#diff-file-path').textContent()) === 'src/beta.js');

  // --- Shift+F7 backwards from first change of beta.js goes back to alpha.js
  await press('Shift+F7'); // arms (already at first/only change)
  await press('Shift+F7');
  await expect('Shift+F7 returns to previous file', async () =>
    (await page.locator('#diff-file-path').textContent()) === 'src/alpha.js');

  // --- keymap customization: rebind Next Difference from F7 to Ctrl+J
  //     (this platform is non-mac, so the "Mod" pseudo-modifier is Ctrl)
  await press('Control+Comma'); // default keymap-settings binding: Mod+,
  await expect('keymap dialog opens', async () =>
    !(await page.locator('#keymap-overlay').getAttribute('class'))?.includes('hidden'));
  await page
    .locator('.keymap-row[data-action="next-diff"] .keymap-shortcut')
    .click();
  await expect('shortcut cell is recording', async () =>
    /Press shortcut/.test(
      (await page.locator('.keymap-row[data-action="next-diff"] .keymap-shortcut').textContent()) || ''
    ));
  await press('Control+J');
  await expect('new shortcut recorded', async () =>
    (await page.locator('.keymap-row[data-action="next-diff"] .keymap-shortcut').textContent()) ===
    'Ctrl+J');
  await expect('override persisted to settings', async () =>
    settings.keymap && (settings.keymap as Record<string, string>)['next-diff'] === 'Ctrl+J');
  await page.locator('#keymap-done').click();
  await expect('keymap dialog closes', async () =>
    (await page.locator('#keymap-overlay').getAttribute('class'))?.includes('hidden'));

  // F7 is no longer bound — pressing it must not navigate anywhere.
  await press('F7');
  await press('F7');
  await expect('F7 does nothing after rebind', async () =>
    (await page.locator('#diff-file-path').textContent()) === 'src/alpha.js');

  // Ctrl+J now drives the IntelliJ flow: arm at last difference, then jump.
  // (cursor sits at alpha's last change after the Shift+F7 continuation)
  await press('Control+J');
  await expect('rebound key arms next-file hint (with new key name)', async () =>
    /Ctrl\+J to go to the next file/.test((await page.locator('#toast').textContent()) || ''));
  await press('Control+J');
  await expect('rebound key continues to next file', async () =>
    (await page.locator('#diff-file-path').textContent()) === 'src/beta.js');

  // Reset All restores F7.
  await press('Control+Comma');
  await expect('override marker shown for rebound action', async () =>
    (await page.locator('.keymap-row[data-action="next-diff"] .overridden-marker').count()) === 1);
  await page.locator('#keymap-reset-all').click();
  await expect('reset-all clears the override', async () =>
    (await page.locator('.keymap-row[data-action="next-diff"] .keymap-shortcut').textContent()) ===
    'F7');
  await page.locator('#keymap-done').click();
  await press('F7'); // beta.js has one change; cursor is on it → arms
  await press('F7');
  await expect('F7 works again after reset', async () =>
    (await page.locator('#diff-file-path').textContent()) === 'notes.txt');

  // --- themes: Islands Dark by default, switchable via the Settings dialog
  await expect('Islands Dark is the default theme', async () =>
    page.evaluate(
      () =>
        document.body.dataset.theme === 'islands-dark' &&
        document.body.dataset.themeStyle === 'islands' &&
        getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === '#1e1f22'
    ));
  await press('Control+Comma');
  await expect('theme select shows current theme', async () =>
    (await page.locator('#theme-select').inputValue()) === 'islands-dark');
  await page.locator('#theme-select').selectOption('darcula');
  await expect('darcula applied to DOM and CSS vars', async () =>
    page.evaluate(
      () =>
        document.body.dataset.theme === 'darcula' &&
        document.body.dataset.themeStyle === 'classic' &&
        getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === '#2b2b2b'
    ));
  await expect('theme persisted to settings', async () => settings.theme === 'darcula');
  await expect('monaco editor recolored', async () =>
    page.evaluate(() => {
      // Monaco applies the theme's editor.background to .monaco-editor
      // (directly or via the --vscode-editor-background variable).
      const el = document.querySelector('#diff-editor .monaco-editor');
      if (!el) return false;
      const cs = getComputedStyle(el);
      return (
        cs.backgroundColor === 'rgb(43, 43, 43)' ||
        cs.getPropertyValue('--vscode-editor-background').trim() === '#2b2b2b'
      );
    }));
  await page.locator('#theme-select').selectOption('islands-light');
  await expect('light theme applied', async () =>
    page.evaluate(
      () =>
        document.body.dataset.theme === 'islands-light' &&
        getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === '#ffffff'
    ));
  await page.locator('#theme-select').selectOption('islands-dark');

  // --- file list position: defaults to left, movable to the right side
  await expect('panel side defaults to left', async () =>
    page.evaluate(
      () =>
        !document.body.classList.contains('panel-right') &&
        document.getElementById('commit-panel')!.getBoundingClientRect().left <
          document.getElementById('diff-pane')!.getBoundingClientRect().left
    ));
  await page.locator('#panel-side-select').selectOption('right');
  await expect('file list moves to the right of the diff pane', async () =>
    page.evaluate(
      () =>
        document.body.classList.contains('panel-right') &&
        document.getElementById('commit-panel')!.getBoundingClientRect().left >
          document.getElementById('diff-pane')!.getBoundingClientRect().left
    ));
  await expect('panel side persisted to settings', async () => settings.panelSide === 'right');
  await page.locator('#panel-side-select').selectOption('left');
  await expect('file list moves back to the left', async () =>
    page.evaluate(
      () =>
        !document.body.classList.contains('panel-right') &&
        document.getElementById('commit-panel')!.getBoundingClientRect().left <
          document.getElementById('diff-pane')!.getBoundingClientRect().left
    ));
  await page.locator('#keymap-done').click();

  // --- tree keyboard: Escape focuses tree, arrows move selection, space toggles
  await page.keyboard.press('Escape');
  await expect('escape focuses tree', async () =>
    page.evaluate(() => document.activeElement && document.activeElement.id === 'tree'));
  await expect('all 3 files checked initially', async () =>
    (await page.locator('#commit-count').textContent()) === '3 of 3 selected');
  await expect('a file row is selected', async () =>
    (await page.locator('.tree-row.selected').count()) === 1);
  await page.keyboard.press('Space');
  await expect('space unchecks selected file', async () =>
    (await page.locator('#commit-count').textContent()) === '2 of 3 selected');
  await page.keyboard.press('Space');

  // --- editing the modified side marks dirty; Cmd+S path is menu-driven, so
  //     verify autosave-on-file-switch instead (the IntelliJ behavior).
  await page.locator('.tree-row[data-key="file:src/beta.js"]').click();
  await expect('beta.js open for edit', async () =>
    (await page.locator('#diff-file-path').textContent()) === 'src/beta.js');
  await page.locator('#diff-editor .editor.modified .view-lines').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' // tweaked');
  await expect('dirty marker appears', async () =>
    (await page.locator('#diff-dirty').textContent()) === '*');
  await page.locator('.tree-row[data-key="file:src/alpha.js"]').click();
  await expect('autosave on switch persisted edit', async () =>
    fs.readFileSync(path.join(repo, 'src/beta.js'), 'utf8').includes('// tweaked'));

  // --- commit flow: uncheck notes.txt, commit the rest via Ctrl+Enter
  await page.locator('.tree-row[data-key="file:notes.txt"] input[type=checkbox]').click();
  await expect('2 of 3 selected for commit', async () =>
    (await page.locator('#commit-count').textContent()) === '2 of 3 selected');
  await page.locator('#commit-message').fill('feat: update from diffier');
  await page.keyboard.press('Control+Enter');
  await expect('commit toast shown', async () =>
    /Committed/.test((await page.locator('#toast').textContent()) || ''));
  await expect('tree shows only uncommitted file', async () =>
    (await page.locator('#tree .tree-row[data-key^="file:"]').count()) === 1);
  const lastMsg = (await gitlib.lastCommitMessage(repo)).trim();
  if (lastMsg !== 'feat: update from diffier') {
    throw new Error('commit message mismatch: ' + lastMsg);
  }

  // --- rollback the remaining untracked file via toolbar
  await page.locator('.tree-row[data-key="file:notes.txt"]').click();
  await page.locator('#btn-rollback').click();
  await expect('rollback removes untracked file', async () =>
    !fs.existsSync(path.join(repo, 'notes.txt')));
  await expect('empty state after all changes resolved', async () =>
    /No changes/.test((await page.locator('#tree').textContent()) || ''));

  // --- syntax highlighting: shiki grammars for languages Monaco lacks
  await expect('shiki highlighter initialized', async () =>
    page.evaluate(() => window.__shikiActive === true));

  fs.writeFileSync(
    path.join(repo, 'config.toml'),
    '# server config\n[server]\nport = 8080\nname = "api"\nenabled = true\n'
  );
  fs.writeFileSync(
    path.join(repo, 'Makefile'),
    '# build\nCC := gcc\nall: main.o\n\t$(CC) -o app main.o\n'
  );
  fs.writeFileSync(
    path.join(repo, 'App.vue'),
    '<template>\n  <div>{{ msg }}</div>\n</template>\n<script>\nexport default { data: () => ({ msg: "hi" }) }\n</script>\n'
  );
  await page.locator('#btn-refresh').click();
  await expect('new language files appear', async () =>
    (await page.locator('#tree .tree-row[data-key^="file:"]').count()) === 3);

  const openAndGetLang = async (key: string): Promise<string | null> => {
    await page.locator(`.tree-row[data-key="file:${key}"]`).click();
    await page.waitForTimeout(400);
    return page.evaluate(() => {
      const models = monaco.editor.getModels();
      return models.length ? models[models.length - 1]!.getLanguageId() : null;
    });
  };

  await expect('TOML detected and highlighted via shiki', async () => {
    if ((await openAndGetLang('config.toml')) !== 'toml') return false;
    // Multiple distinct token colors on screen proves tokenization ran.
    return page.evaluate(() => {
      const classes = new Set<string>();
      for (const el of document.querySelectorAll('#diff-editor .view-line span')) {
        for (const c of el.classList) if (c.startsWith('mtk')) classes.add(c);
      }
      return classes.size >= 2;
    });
  });
  await expect('Makefile detected as make', async () =>
    (await openAndGetLang('Makefile')) === 'make');
  await expect('Vue SFC detected with real vue grammar', async () =>
    (await openAndGetLang('App.vue')) === 'vue');

  // Every language in the shiki set must colorize without throwing.
  const langErrors = await page.evaluate(async (ids: string[]) => {
    const errs: string[] = [];
    for (const id of ids) {
      try {
        await monaco.editor.colorize('test { "x" = 1 } # c\n', id, {});
      } catch (e) {
        errs.push(id + ': ' + (e instanceof Error ? e.message : String(e)));
      }
    }
    return errs;
  }, languagesLib.SHIKI_LANGUAGES.map((l) => l.id));
  if (langErrors.length) throw new Error('colorize failures:\n' + langErrors.join('\n'));
  console.log('  ok: all shiki languages colorize cleanly');

  // Clean up so the repo ends with no changes again.
  await gitlib.rollback(repo, (await gitlib.status(repo)).files);
  await page.locator('#btn-refresh').click();
  await expect('repo clean before feature tests', async () =>
    /No changes/.test((await page.locator('#tree').textContent()) || ''));

  // --- partial staging: exclude one of two hunks, commit the other
  fs.writeFileSync(
    path.join(repo, 'src/alpha.js'),
    'function a() {\n  return 111;\n}\n\nfunction b() {\n  return 2;\n}\n\nfunction c() {\n  return 333;\n}\n'
  );
  await page.locator('#btn-refresh').click();
  await page.locator('.tree-row[data-key="file:src/alpha.js"]').click();
  await expect('alpha.js reopened with 2 hunks', async () =>
    (await page.locator('#diff-count').textContent()) === '2 differences');
  await expect('hunk checkboxes rendered in the gutter', async () =>
    (await page.locator('.hunk-check.checked').count()) === 2);
  await page.locator('.hunk-check').nth(1).click();
  await expect('second hunk excluded', async () =>
    (await page.locator('.hunk-check.unchecked').count()) === 1);
  // Files seen in an earlier refresh don't re-check themselves — check it.
  const alphaCb = page.locator('.tree-row[data-key="file:src/alpha.js"] input[type=checkbox]');
  if (!(await alphaCb.isChecked())) await alphaCb.click();
  await expect('commit count reports a partial file', async () =>
    /1 partial/.test((await page.locator('#commit-count').textContent()) || ''));
  await page.locator('#commit-message').fill('feat: first hunk only');
  await page.keyboard.press('Control+Enter');
  await expect('partial commit toast', async () =>
    /Committed/.test((await page.locator('#toast').textContent()) || ''));
  await expect('committed content has hunk 1 but not hunk 2', async () => {
    const head = execFileSync('git', ['show', 'HEAD:src/alpha.js'], { cwd: repo }).toString();
    return head.includes('return 111') && head.includes('return 300');
  });
  await expect('excluded hunk survives as a local change', async () =>
    (await page.locator('.tree-row[data-key="file:src/alpha.js"]').count()) === 1);

  // --- blame annotations on the remaining modified file
  await page.locator('.tree-row[data-key="file:src/alpha.js"]').click();
  await page.waitForTimeout(300);
  await page.locator('#btn-blame').click();
  await expect('blame annotations rendered', async () =>
    (await page.locator('.blame-inline').count()) > 0);
  await page.locator('#btn-blame').click();
  await expect('blame annotations cleared', async () =>
    (await page.locator('.blame-inline').count()) === 0);

  // --- file history via context menu
  await page.locator('.tree-row[data-key="file:src/alpha.js"]').click({ button: 'right' });
  await expect('context menu opens', async () =>
    !(await page.locator('#context-menu').getAttribute('class'))?.includes('hidden'));
  await page.locator('#context-menu .popup-item', { hasText: 'Show History' }).click();
  await expect('log opens in file-history mode', async () =>
    !(await page.locator('#log-file-filter').getAttribute('class'))?.includes('hidden') &&
    /src\/alpha\.js/.test((await page.locator('#log-file-filter-label').textContent()) || ''));
  await expect('history lists the commits touching the file', async () =>
    (await page.locator('.log-row').count()) >= 2);
  await page.locator('#log-file-filter-clear').click();

  // --- directory context menu: Copy Path / Reveal in Finder
  await page.locator('#tab-commit').click();
  await page.locator('.tree-row[data-key="dir:src"]').click({ button: 'right' });
  await expect('context menu opens for a directory row', async () =>
    !(await page.locator('#context-menu').getAttribute('class'))?.includes('hidden'));
  await page.locator('#context-menu .popup-item', { hasText: 'Copy Path' }).click();
  await expect('directory path copied', async () => (await page.evaluate(() => window.__copiedText)) === 'src');
  await page.locator('.tree-row[data-key="dir:src"]').click({ button: 'right' });
  await page.locator('#context-menu .popup-item', { hasText: 'Reveal in Finder' }).click();
  await expect('directory revealed', async () => revealedPaths.includes('src'));

  // --- log tab: full history, commit details, per-commit file diff
  await page.locator('#tab-log').click();
  await expect('full log shows all commits', async () =>
    (await page.locator('.log-row').count()) >= 3);
  await expect('refs chip on HEAD commit', async () =>
    (await page.locator('.log-ref').count()) >= 1);
  await page.locator('.log-row').first().click();
  await expect('commit details appear', async () =>
    !(await page.locator('#log-details').getAttribute('class'))?.includes('hidden') &&
    /first hunk only/.test((await page.locator('#log-details-header').textContent()) || ''));
  await page.locator('#log-details-files .tree-row[data-key="file:src/alpha.js"]').click();
  await expect('read-only commit diff opens with @rev in header', async () =>
    /@/.test((await page.locator('#diff-file-path').textContent()) || ''));

  // --- next/prev file buttons walk the commit's file list, not the worktree tree
  await page.locator('.log-row').last().click(); // "seed" commit: alpha.js + beta.js
  await expect('seed commit details appear', async () =>
    /seed/.test((await page.locator('#log-details-header').textContent()) || ''));
  await expect('first file in the commit opens automatically, no click needed', async () =>
    /alpha\.js/.test((await page.locator('#diff-file-path').textContent()) || '') &&
    (await page.locator('#log-details-files .tree-row[data-key="file:src/alpha.js"]').getAttribute('class'))?.includes('selected'));
  await page.locator('#btn-next-file').click();
  await expect('next-file button advances within the commit, staying read-only', async () =>
    /src\/beta\.js @/.test((await page.locator('#diff-file-path').textContent()) || ''));
  await page.locator('#btn-prev-file').click();
  await expect('prev-file button goes back to alpha.js, still read-only', async () =>
    /src\/alpha\.js @/.test((await page.locator('#diff-file-path').textContent()) || ''));

  // --- compare tab: diff two arbitrary refs by hash
  const seedHash = await page.locator('.log-row').last().getAttribute('data-hash');
  const headHash = await page.locator('.log-row').first().getAttribute('data-hash');
  await page.locator('#tab-compare').click();
  await page.locator('#compare-ref-a').fill(seedHash!);
  await page.locator('#compare-ref-b').fill(headHash!);
  await page.locator('#compare-btn').click();
  await expect('compare tree shows files changed between the two commits', async () =>
    (await page.locator('#compare-files .tree-row[data-key^="file:"]').count()) >= 1);
  await expect('first compared file opens automatically, read-only', async () =>
    new RegExp(`${seedHash} → ${headHash}`).test((await page.locator('#diff-file-path').textContent()) || ''));
  await page.locator('#compare-ref-b').fill('');
  await page.locator('#compare-btn').click();
  await expect('blank target ref compares base ref against the working tree', async () =>
    /Working Tree/.test((await page.locator('#diff-file-path').textContent()) || ''));

  await page.locator('#tab-commit').click();

  // --- filter box narrows the tree
  fs.writeFileSync(path.join(repo, 'aaa-match.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, 'bbb-other.txt'), 'b\n');
  await page.locator('#btn-refresh').click();
  await expect('3 changed files before filtering', async () =>
    (await page.locator('#tree .tree-row[data-key^="file:"]').count()) === 3);
  await page.locator('#tree-filter').fill('aaa');
  await expect('filter narrows to 1 file', async () =>
    (await page.locator('#tree .tree-row[data-key^="file:"]').count()) === 1);
  await page.locator('#tree-filter-clear').click();
  await expect('clearing filter restores the tree', async () =>
    (await page.locator('#tree .tree-row[data-key^="file:"]').count()) === 3);

  // --- stash dialog: stash everything, then pop it back
  await page.locator('#btn-stash').click();
  await expect('stash dialog opens', async () =>
    !(await page.locator('#stash-overlay').getAttribute('class'))?.includes('hidden'));
  await page.locator('#stash-message').fill('wip from ui test');
  await page.locator('#btn-stash-push').click();
  await expect('stash created and listed', async () =>
    (await page.locator('.stash-row').count()) === 1 &&
    /wip from ui test/.test((await page.locator('.stash-row .stash-msg').textContent()) || ''));
  await expect('working tree clean after stash', async () =>
    (await gitlib.status(repo)).files.length === 0);
  await page.locator('.stash-row').hover();
  await page.locator('.stash-row .stash-actions button', { hasText: 'Pop' }).click();
  await expect('stash popped back', async () =>
    (await gitlib.status(repo)).files.length === 3);
  await page.locator('#stash-done').click();

  // --- branch popup: create a branch, switch back to main
  await page.locator('#status-branch').click();
  await expect('branch popup opens with main listed', async () =>
    !(await page.locator('#branch-popup').getAttribute('class'))?.includes('hidden') &&
    (await page.locator('#branch-list .popup-item', { hasText: 'main' }).count()) >= 1);
  await page.locator('#branch-filter').fill('ui-test-branch');
  await page.locator('#branch-list .popup-item', { hasText: 'Create branch' }).click();
  await expect('new branch checked out', async () =>
    (await page.locator('#status-branch').textContent()) === 'ui-test-branch');
  await page.locator('#status-branch').click();
  await page.locator('#branch-list .popup-item', { hasText: 'main' }).first().click();
  await expect('switched back to main', async () =>
    (await page.locator('#status-branch').textContent()) === 'main');

  // --- subject length hint
  await page.locator('#tab-commit').click();
  await page.locator('#commit-message').fill('x'.repeat(60));
  await expect('subject length warns past 50 chars', async () =>
    ((await page.locator('#subject-length').getAttribute('class')) || '').includes('warn'));
  await page.locator('#commit-message').fill('');

  // --- merge conflict resolution
  const g2 = (...args: string[]): string => execFileSync('git', args, { cwd: repo }).toString();
  g2('checkout', '-b', 'conflict-side');
  fs.writeFileSync(path.join(repo, 'aaa-match.txt'), 'side version\n');
  g2('add', '-A');
  g2('commit', '-m', 'side');
  g2('checkout', 'main');
  fs.writeFileSync(path.join(repo, 'aaa-match.txt'), 'main version\n');
  g2('add', '-A');
  g2('commit', '-m', 'mainline');
  try {
    g2('merge', 'conflict-side');
  } catch {
    /* conflict expected */
  }
  await page.locator('#btn-refresh').click();
  await expect('conflicted file shown in tree', async () =>
    (await page.locator('.file-name.CONFLICT').count()) >= 1);
  await page.locator('.tree-row[data-key="file:aaa-match.txt"]').click();
  await expect('conflict bar appears', async () =>
    !(await page.locator('#conflict-bar').getAttribute('class'))?.includes('hidden') &&
    /Conflict 1 of 1|1 conflict/.test((await page.locator('#conflict-count').textContent()) || ''));
  await expect('accept-all buttons labeled with branch names', async () =>
    /main/.test((await page.locator('#btn-all-ours').textContent()) || '') &&
    /conflict-side/.test((await page.locator('#btn-all-theirs').textContent()) || ''));
  await page.locator('#btn-all-theirs').click();
  await expect('conflicts resolved in the editor', async () =>
    /No conflicts left/.test((await page.locator('#conflict-count').textContent()) || ''));
  await page.locator('#btn-mark-resolved').click();
  await expect('file staged as resolved', async () => {
    const st = await gitlib.status(repo);
    return !st.files.some((f) => f.type === 'CONFLICT');
  });
  await expect('theirs content won', async () =>
    fs.readFileSync(path.join(repo, 'aaa-match.txt'), 'utf8') === 'side version\n');
  g2('commit', '-m', 'merged in ui test');

  // --- markdown preview: unified rendered diff for .md files
  fs.writeFileSync(path.join(repo, 'README.md'), '# Title\n\nOld intro.\n');
  g2('add', 'README.md');
  g2('commit', '-m', 'add readme');
  fs.writeFileSync(
    path.join(repo, 'README.md'),
    '# Title v2\n\nNew **intro** with [a link](https://example.com) and `code`.\n\n' +
      '- item one\n- item two\n\n```js\nconst x = 1;\n```\n\n' +
      '<script>window.__mdPwned = true</script>\n'
  );
  await page.locator('#btn-refresh').click();
  await page.locator('.tree-row[data-key="file:README.md"]').click();
  await expect('markdown toggle appears for .md file', async () =>
    !((await page.locator('#btn-md-view').getAttribute('class')) || '').includes('hidden'));
  await expect('text diff shown first', async () =>
    ((await page.locator('#markdown-diff').getAttribute('class')) || '').includes('hidden'));
  await page.locator('#btn-md-view').click();
  await expect('unified view renders removed and added blocks', async () =>
    !((await page.locator('#markdown-diff').getAttribute('class')) || '').includes('hidden') &&
    (await page.locator('.md-removed h1').textContent()) === 'Title' &&
    (await page.locator('.md-added h1').textContent()) === 'Title v2');
  await expect('inline formatting and blocks rendered', async () =>
    (await page.locator('.md-added strong').textContent()) === 'intro' &&
    (await page.locator('.md-added li').count()) === 2 &&
    (await page.locator('.md-added pre code').count()) === 1);
  await expect('raw HTML stays inert text', async () =>
    page.evaluate(
      () =>
        !window.__mdPwned &&
        !document.querySelector('.md-added script') &&
        (document.getElementById('md-diff-body')!.textContent || '').includes('<script>')
    ));
  await page.locator('.md-added a', { hasText: 'a link' }).click();
  await expect('link click routed to shell.openExternal, no navigation', async () =>
    openedExternally[0] === 'https://example.com' && /index\.html/.test(page.url()));
  await page.locator('#btn-md-view').click();
  await expect('toggle returns to the text diff', async () =>
    ((await page.locator('#markdown-diff').getAttribute('class')) || '').includes('hidden') &&
    (await page.locator('#diff-count').textContent()) !== '');
  // Added file (no old side): every block renders as added, none removed.
  fs.writeFileSync(path.join(repo, 'NEW.md'), '# Brand new\n\nFresh content.\n');
  await page.locator('#btn-refresh').click();
  await page.locator('.tree-row[data-key="file:NEW.md"]').click();
  await page.locator('#btn-md-view').click();
  await expect('added file has no removed blocks', async () =>
    (await page.locator('.md-removed').count()) === 0 &&
    (await page.locator('.md-added h1').textContent()) === 'Brand new');
  await page.locator('.tree-row[data-key="file:README.md"]').click();
  await page.locator('#btn-md-view').click();
  await expect('a modified file shows both removed and added blocks', async () =>
    (await page.locator('.md-removed').count()) > 0 &&
    (await page.locator('.md-added').count()) > 0);
  await expect('diff ruler has a mark per changed block', async () =>
    page.evaluate(() => {
      const marks = document.querySelectorAll('#md-diff-ruler .md-diff-ruler-mark').length;
      const blocks = document.querySelectorAll('#md-diff-body .md-added, #md-diff-body .md-removed').length;
      return marks > 0 && marks === blocks;
    }));

  // F7/Shift+F7 walk changed blocks in the markdown view instead of Monaco
  // line changes. Content tall enough that the changes near the end can't
  // fit on screen with the ones near the top, so a real scroll is
  // observable once navigation reaches them — the two edited paragraphs
  // near the very top center-clamp to scrollTop 0 (nothing above them to
  // scroll past), which is what originally masked index tracking getting
  // stuck re-finding the same block forever instead of advancing.
  fs.writeFileSync(
    path.join(repo, 'TALL.md'),
    Array.from({ length: 30 }, (_, i) => `Paragraph ${i} filler text to force scrolling.`).join('\n\n') + '\n'
  );
  g2('add', 'TALL.md');
  g2('commit', '-m', 'add tall md');
  const tallLines = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} filler text to force scrolling.`);
  tallLines[0] = 'Paragraph 0 EDITED filler text to force scrolling.';
  tallLines[29] = 'Paragraph 29 EDITED filler text to force scrolling.';
  fs.writeFileSync(path.join(repo, 'TALL.md'), tallLines.join('\n\n') + '\n');
  await page.locator('#btn-refresh').click();
  await page.locator('.tree-row[data-key="file:TALL.md"]').click();
  await page.locator('#btn-md-view').click();
  const mdScrollTop = () => page.evaluate(() => document.getElementById('md-diff-body')!.scrollTop);
  await expect('markdown view starts scrolled to the top', async () => (await mdScrollTop()) === 0);
  // 4 changed blocks: removed+added near paragraph 0 (top, clamp to 0),
  // removed+added near paragraph 29 (bottom, requires scrolling).
  await page.keyboard.press('F7');
  await page.keyboard.press('F7');
  await expect('first two changes (near the top) stay in view without scrolling', async () =>
    (await mdScrollTop()) === 0);
  await page.keyboard.press('F7');
  await expect('third F7 advances past the top pair and scrolls to the bottom change', async () =>
    (await mdScrollTop()) > 0);
  const afterThird = await mdScrollTop();
  await page.keyboard.press('F7');
  await expect('F7 stays on the last change, no further movement', async () => (await mdScrollTop()) === afterThird);
  await page.keyboard.press('F7');
  await expect('F7 past the last change shows a toast instead of looping', async () =>
    /No more changes/.test((await page.locator('#toast').textContent()) || ''));
  await page.keyboard.press('Shift+F7');
  await page.keyboard.press('Shift+F7');
  await page.keyboard.press('Shift+F7');
  await expect('Shift+F7 walks back to the top change', async () => (await mdScrollTop()) === 0);
  await page.keyboard.press('Shift+F7');
  await expect('Shift+F7 past the first change shows a toast instead of looping', async () =>
    /No more changes/.test((await page.locator('#toast').textContent()) || ''));
  await page.locator('.tree-row[data-key="file:README.md"]').click();
  await page.locator('#btn-md-view').click();

  // --- zoom: Mod+=/Mod+-/Mod+Shift+0 scale the diff editor and markdown font
  const diffFontSize = async (): Promise<number | null> =>
    page.evaluate(() => (window as unknown as { currentDiffEditorFontSize(): number | null }).currentDiffEditorFontSize());
  const mdFontSize = async (): Promise<string> =>
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--md-font-size').trim());
  const baseDiffFontSize = await diffFontSize();
  await press('Control+Equal');
  await press('Control+Equal');
  await expect('zoom in increases diff editor font size', async () =>
    (await diffFontSize()) === baseDiffFontSize! + 2);
  await expect('zoom in increases markdown font size', async () => (await mdFontSize()) === '15px');
  await press('Control+Minus');
  await expect('zoom out decreases diff editor font size', async () =>
    (await diffFontSize()) === baseDiffFontSize! + 1);
  await press('Control+Shift+0');
  await expect('zoom reset restores diff editor font size', async () => (await diffFontSize()) === baseDiffFontSize);
  await expect('zoom reset restores markdown font size', async () => (await mdFontSize()) === '13px');

  // A refresh whose diff content is unchanged (fs watcher, focus, manual)
  // must leave the preview toggles alone — it used to strip the markdown
  // button off the toolbar while the rendered pane stayed on screen.
  await page.locator('#btn-refresh').click();
  await expect('refresh keeps the markdown toggle and the rendered view', async () =>
    ((await page.locator('#btn-md-view').getAttribute('class')) || '').includes('active') &&
    !((await page.locator('#btn-md-view').getAttribute('class')) || '').includes('hidden') &&
    !((await page.locator('#markdown-diff').getAttribute('class')) || '').includes('hidden'));

  fs.writeFileSync(path.join(repo, 'plain.txt'), 'plain\n');
  await page.locator('#btn-refresh').click();
  await page.locator('.tree-row[data-key="file:plain.txt"]').click();
  await expect('markdown toggle hidden for non-md file', async () =>
    ((await page.locator('#btn-md-view').getAttribute('class')) || '').includes('hidden'));

  // Final cleanup.
  await gitlib.rollback(repo, (await gitlib.status(repo)).files);
  await page.locator('#btn-refresh').click();

  if (consoleErrors.length) {
    throw new Error('Console errors:\n' + consoleErrors.join('\n'));
  }

  await browser.close();
  server.close();
  console.log('ui.test.js OK');
  void line;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
