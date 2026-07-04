'use strict';

/*
 * End-to-end UI test. Electron binaries can't be downloaded in every
 * environment, but the renderer talks to the main process exclusively via
 * `window.api`, so we serve the renderer over HTTP, shim `window.api` with
 * fetch calls to a tiny RPC server backed by the real main/git.js, and drive
 * the UI with Playwright + the preinstalled Chromium.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const gitlib = require('../main/git');
const keymapLib = require('../main/keymap');
const themesLib = require('../main/themes');

const ROOT = path.join(__dirname, '..');

// ------------------------------------------------------------- test repo

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'diffier-ui-'));
const g = (...args) => execFileSync('git', args, { cwd: repo }).toString();

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

const settings = { lastRepo: repo };
const rpc = {
  'repo:last': async () => ({
    root: repo,
    name: path.basename(repo),
    isWorktree: false,
    recents: [repo],
  }),
  'repo:open': async ([dir]) => ({
    root: dir,
    name: path.basename(dir),
    isWorktree: false,
    recents: [dir],
  }),
  'git:status': () => gitlib.status(repo),
  'git:diff': ([p, t, o]) => gitlib.fileDiff(repo, p, t, o),
  'git:commit': ([{ files, message, amend, partials }]) =>
    gitlib.commit(repo, files, message, amend, partials || []),
  'git:rollback': ([files]) => gitlib.rollback(repo, files),
  'git:lastMessage': () => gitlib.lastCommitMessage(repo),
  'git:pull': () => gitlib.pull(repo),
  'git:fetch': () => gitlib.fetch(repo),
  'git:branches': () => gitlib.branches(repo),
  'git:checkout': ([name]) => gitlib.checkout(repo, name),
  'git:createBranch': ([name]) => gitlib.createBranch(repo, name),
  'git:log': ([opts]) => gitlib.log(repo, opts || {}),
  'git:commitDetails': ([hash]) => gitlib.commitDetails(repo, hash),
  'git:commitFileDiff': ([hash, p, t, o, r2]) => gitlib.commitFileDiff(repo, hash, p, t, o, r2),
  'git:stashList': () => gitlib.stashList(repo),
  'git:stashPush': ([msg, untracked]) => gitlib.stashPush(repo, msg, untracked),
  'git:stashPop': ([ref]) => gitlib.stashPop(repo, ref),
  'git:stashApply': ([ref]) => gitlib.stashApply(repo, ref),
  'git:stashDrop': ([ref]) => gitlib.stashDrop(repo, ref),
  'git:blame': ([p]) => gitlib.blame(repo, p),
  'git:conflictInfo': ([p]) => gitlib.conflictInfo(repo, p),
  'git:markResolved': ([p, c]) => gitlib.markResolved(repo, p, c),
  'git:commitTemplate': async () => '',
  'app:badge': async () => null,
  'file:save': ([p, c]) => gitlib.saveFile(repo, p, c),
  'settings:get': async () => settings,
  'settings:set': async ([patch]) => Object.assign(settings, patch),
  'keymap:set': async ([overrides]) => {
    settings.keymap = overrides;
  },
  'app:confirm': async () => true,
};

const MIME = {
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
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found: ' + rel);
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
        gitCommitFileDiff: 'git:commitFileDiff', gitStashList: 'git:stashList',
        gitStashPush: 'git:stashPush', gitStashPop: 'git:stashPop',
        gitStashApply: 'git:stashApply', gitStashDrop: 'git:stashDrop',
        gitBlame: 'git:blame', gitConflictInfo: 'git:conflictInfo',
        gitMarkResolved: 'git:markResolved', gitCommitTemplate: 'git:commitTemplate',
        setBadge: 'app:badge', gitRollback: 'git:rollback',
        gitLastMessage: 'git:lastMessage', saveFile: 'file:save',
        getSettings: 'settings:get', setSettings: 'settings:set',
        confirm: 'app:confirm', revealFile: 'shell:reveal', setKeymap: 'keymap:set',
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

async function main() {
  const { chromium } = require('playwright-core');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/renderer/index.html`;

  const browser = await chromium.launch({
    executablePath: process.env.DIFFIER_CHROMIUM || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/worker|falling back/i.test(msg.text())) {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  await page.addInitScript(API_SHIM);
  await page.goto(url);

  const expect = async (desc, fn, timeout = 10000) => {
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
    (await page.locator('.tree-row[data-key^="file:"]').count()) === 3);
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
  const line = async () =>
    page.evaluate(() => window.__pos && window.__pos());
  await page.evaluate(() => {
    // expose cursor position for assertions
    window.__pos = () => {
      const sel = document.querySelector('#diff-editor');
      return sel ? true : false;
    };
  });

  const press = async (key) => {
    await page.keyboard.press(key);
    await page.waitForTimeout(400); // human-paced; file switches are async
  };

  await press('F7'); // to second hunk (cursor starts at first)
  await press('F7'); // at last difference → arms the next-file hint
  await expect('F7 arms next-file toast at last difference', async () =>
    /next file/i.test(await page.locator('#toast').textContent()));
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
    !(await page.locator('#keymap-overlay').getAttribute('class')).includes('hidden'));
  await page
    .locator('.keymap-row[data-action="next-diff"] .keymap-shortcut')
    .click();
  await expect('shortcut cell is recording', async () =>
    /Press shortcut/.test(
      await page.locator('.keymap-row[data-action="next-diff"] .keymap-shortcut').textContent()
    ));
  await press('Control+J');
  await expect('new shortcut recorded', async () =>
    (await page.locator('.keymap-row[data-action="next-diff"] .keymap-shortcut').textContent()) ===
    'Ctrl+J');
  await expect('override persisted to settings', async () =>
    settings.keymap && settings.keymap['next-diff'] === 'Ctrl+J');
  await page.locator('#keymap-done').click();
  await expect('keymap dialog closes', async () =>
    (await page.locator('#keymap-overlay').getAttribute('class')).includes('hidden'));

  // F7 is no longer bound — pressing it must not navigate anywhere.
  await press('F7');
  await press('F7');
  await expect('F7 does nothing after rebind', async () =>
    (await page.locator('#diff-file-path').textContent()) === 'src/alpha.js');

  // Ctrl+J now drives the IntelliJ flow: arm at last difference, then jump.
  // (cursor sits at alpha's last change after the Shift+F7 continuation)
  await press('Control+J');
  await expect('rebound key arms next-file hint (with new key name)', async () =>
    /Ctrl\+J to go to the next file/.test(await page.locator('#toast').textContent()));
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
    /Committed/.test(await page.locator('#toast').textContent()));
  await expect('tree shows only uncommitted file', async () =>
    (await page.locator('.tree-row[data-key^="file:"]').count()) === 1);
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
    /No changes/.test(await page.locator('#tree').textContent()));

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
    (await page.locator('.tree-row[data-key^="file:"]').count()) === 3);

  const openAndGetLang = async (key) => {
    await page.locator(`.tree-row[data-key="file:${key}"]`).click();
    await page.waitForTimeout(400);
    return page.evaluate(() => {
      const models = monaco.editor.getModels();
      return models.length ? models[models.length - 1].getLanguageId() : null;
    });
  };

  await expect('TOML detected and highlighted via shiki', async () => {
    if ((await openAndGetLang('config.toml')) !== 'toml') return false;
    // Multiple distinct token colors on screen proves tokenization ran.
    return page.evaluate(() => {
      const classes = new Set();
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
  const langErrors = await page.evaluate(async (ids) => {
    const errs = [];
    for (const id of ids) {
      try {
        await monaco.editor.colorize('test { "x" = 1 } # c\n', id, {});
      } catch (e) {
        errs.push(id + ': ' + (e.message || e));
      }
    }
    return errs;
  }, require('../renderer/languages').SHIKI_LANGUAGES.map((l) => l.id));
  if (langErrors.length) throw new Error('colorize failures:\n' + langErrors.join('\n'));
  console.log('  ok: all shiki languages colorize cleanly');

  // Clean up so the repo ends with no changes again.
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
  console.error(err.message || err);
  process.exit(1);
});
