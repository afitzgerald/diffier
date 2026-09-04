// Non-interactive driver for launching Diffier and taking a screenshot.
// Run from the repo root (needs playwright-core + electron from node_modules).
//
// Usage: node .claude/skills/run-diffier/driver.mjs <repo-dir> <out.png> [theme] [user-data-dir]
//   theme:         omit for the default (Islands Dark), or "light" for Islands Light
//   user-data-dir: defaults to a scratch dir — ALWAYS pass an isolated one (see
//                  Gotchas in SKILL.md); never launch against the real profile.
import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '../../..');
const [, , REPO_DIR, OUT, THEME, USER_DATA = '/tmp/diffier-shot-profile'] = process.argv;
if (!REPO_DIR || !OUT) {
  console.error('usage: node driver.mjs <repo-dir> <out.png> [theme] [user-data-dir]');
  process.exit(1);
}

const electronBin =
  process.platform === 'darwin'
    ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : path.join(APP_DIR, 'node_modules/electron/dist/electron');

const app = await electron.launch({
  executablePath: electronBin,
  args: [
    `--user-data-dir=${USER_DATA}`, // isolate from the real ~/Library profile — see Gotchas
    '--force-device-scale-factor=1', // match the committed 1440x900 assets, not a Retina 2x capture
    '--no-sandbox',
    APP_DIR,
    REPO_DIR,
  ],
  timeout: 30_000,
});

await new Promise((r) => setTimeout(r, 3000));
const page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? (await app.firstWindow());
await page.waitForSelector('.tree-row', { timeout: 15000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));

// Select the first FILE row (dir rows share the same .tree-row/.file-name
// classes and only toggle expand/collapse when clicked).
await page.evaluate(() => {
  const row = document.querySelector('.tree-row[data-key]:not([data-key^="dir:"])');
  row?.click();
});
await new Promise((r) => setTimeout(r, 1500));

// Populate the commit message box so screenshots don't show an empty
// placeholder — content is generic on purpose; the driver doesn't know
// what fixture it's pointed at.
await page.evaluate(() => {
  const box = document.querySelector('#commit-message');
  if (box) {
    box.value = 'feat: describe the change';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }
});

if (THEME === 'light') {
  // setTheme is a top-level function in the classic-script renderer bundle,
  // so it hangs off window even though nothing exports it.
  await page.evaluate(() => window.setTheme('islands-light'));
  await new Promise((r) => setTimeout(r, 800));
}

await page.screenshot({ path: OUT });
console.log('saved', OUT);
await app.close();
