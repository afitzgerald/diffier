'use strict';

/* Integration test for main/git.js against a throwaway repository. */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const gitlib = require('../main/git');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diffier-test-'));
const run = (...args) =>
  execFileSync('git', args, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString();

async function main() {
  run('init', '-b', 'main');
  run('config', 'user.email', 'test@test.local');
  run('config', 'user.name', 'Test');

  // Seed a commit.
  fs.mkdirSync(path.join(tmp, 'src/util'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src/app.js'), 'line1\nline2\nline3\n');
  fs.writeFileSync(path.join(tmp, 'src/util/helper.js'), 'helper\n');
  fs.writeFileSync(path.join(tmp, 'gone.txt'), 'bye\n');
  run('add', '-A');
  run('commit', '-m', 'seed');

  assert.strictEqual(await gitlib.isRepo(tmp), true);
  assert.strictEqual(await gitlib.repoRoot(tmp), fs.realpathSync(tmp));
  assert.strictEqual(await gitlib.hasHead(tmp), true);
  assert.strictEqual(await gitlib.currentBranch(tmp), 'main');

  // Create every change type: modify, add(stage), delete, untracked, rename.
  fs.writeFileSync(path.join(tmp, 'src/app.js'), 'line1\nCHANGED\nline3\nline4\n');
  fs.writeFileSync(path.join(tmp, 'new-staged.txt'), 'staged new\n');
  run('add', 'new-staged.txt');
  fs.rmSync(path.join(tmp, 'gone.txt'));
  fs.writeFileSync(path.join(tmp, 'untracked.txt'), 'untracked\n');
  run('mv', 'src/util/helper.js', 'src/util/renamed.js');

  const st = await gitlib.status(tmp);
  const byPath = Object.fromEntries(st.files.map((f) => [f.path, f]));
  assert.strictEqual(byPath['src/app.js'].type, 'MODIFIED');
  assert.strictEqual(byPath['new-staged.txt'].type, 'ADDED');
  assert.strictEqual(byPath['gone.txt'].type, 'DELETED');
  assert.strictEqual(byPath['untracked.txt'].type, 'UNVERSIONED');
  assert.strictEqual(byPath['src/util/renamed.js'].type, 'MOVED');
  assert.strictEqual(byPath['src/util/renamed.js'].origPath, 'src/util/helper.js');

  // Diffs.
  const mod = await gitlib.fileDiff(tmp, 'src/app.js', 'MODIFIED', null);
  assert.strictEqual(mod.original, 'line1\nline2\nline3\n');
  assert.strictEqual(mod.modified, 'line1\nCHANGED\nline3\nline4\n');
  assert.strictEqual(mod.binary, false);

  const del = await gitlib.fileDiff(tmp, 'gone.txt', 'DELETED', null);
  assert.strictEqual(del.original, 'bye\n');
  assert.strictEqual(del.modified, '');

  const untracked = await gitlib.fileDiff(tmp, 'untracked.txt', 'UNVERSIONED', null);
  assert.strictEqual(untracked.original, '');
  assert.strictEqual(untracked.modified, 'untracked\n');

  const ren = await gitlib.fileDiff(tmp, 'src/util/renamed.js', 'MOVED', 'src/util/helper.js');
  assert.strictEqual(ren.original, 'helper\n');
  assert.strictEqual(ren.modified, 'helper\n');

  // Binary detection.
  fs.writeFileSync(path.join(tmp, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  const bin = await gitlib.fileDiff(tmp, 'bin.dat', 'UNVERSIONED', null);
  assert.strictEqual(bin.binary, true);

  // Path escape protection.
  await assert.rejects(() => gitlib.fileDiff(tmp, '../etc/passwd', 'MODIFIED', null));
  await assert.rejects(() => gitlib.saveFile(tmp, '../oops.txt', 'x'));

  // Save.
  await gitlib.saveFile(tmp, 'src/app.js', 'edited\n');
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'src/app.js'), 'utf8'), 'edited\n');

  // Partial commit: only two of the changed files.
  await gitlib.commit(tmp, ['src/app.js', 'new-staged.txt'], 'partial commit', false);
  const st2 = await gitlib.status(tmp);
  const paths2 = st2.files.map((f) => f.path).sort();
  assert.ok(!paths2.includes('src/app.js'), 'committed file still dirty');
  assert.ok(!paths2.includes('new-staged.txt'), 'committed file still dirty');
  assert.ok(paths2.includes('gone.txt'), 'uncommitted deletion lost');
  assert.ok(paths2.includes('untracked.txt'), 'untracked file lost');
  assert.strictEqual(await gitlib.lastCommitMessage(tmp), 'partial commit');

  // Amend.
  await gitlib.commit(tmp, ['untracked.txt'], 'partial commit v2', true);
  assert.strictEqual(await gitlib.lastCommitMessage(tmp), 'partial commit v2');
  assert.strictEqual(run('rev-list', '--count', 'HEAD').trim(), '2');

  // Rollback: deletion restored, rename undone, unversioned deleted.
  fs.writeFileSync(path.join(tmp, 'junk.txt'), 'junk\n');
  const st3 = await gitlib.status(tmp);
  await gitlib.rollback(tmp, st3.files);
  const st4 = await gitlib.status(tmp);
  assert.strictEqual(st4.files.length, 0, 'rollback left changes: ' + JSON.stringify(st4.files));
  assert.ok(fs.existsSync(path.join(tmp, 'gone.txt')), 'deleted file not restored');
  assert.ok(fs.existsSync(path.join(tmp, 'src/util/helper.js')), 'rename not undone');
  assert.ok(!fs.existsSync(path.join(tmp, 'src/util/renamed.js')), 'renamed file still present');
  assert.ok(!fs.existsSync(path.join(tmp, 'junk.txt')), 'unversioned file not deleted');

  // Empty-repo edge case (no HEAD yet).
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'diffier-test2-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: tmp2 });
  const stEmpty = await gitlib.status(tmp2);
  assert.strictEqual(stEmpty.hasHead, false);
  assert.strictEqual(stEmpty.files.length, 0);

  console.log('git.test.js OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
