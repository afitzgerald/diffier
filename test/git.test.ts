'use strict';

/* Integration test for main/git.ts against a throwaway repository. */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import * as gitlib from '../main/git';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diffier-test-'));
const run = (...args: string[]): string =>
  execFileSync('git', args, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString();

async function main(): Promise<void> {
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
  assert.strictEqual(byPath['src/app.js']!.type, 'MODIFIED');
  assert.strictEqual(byPath['new-staged.txt']!.type, 'ADDED');
  assert.strictEqual(byPath['gone.txt']!.type, 'DELETED');
  assert.strictEqual(byPath['untracked.txt']!.type, 'UNVERSIONED');
  assert.strictEqual(byPath['src/util/renamed.js']!.type, 'MOVED');
  assert.strictEqual(byPath['src/util/renamed.js']!.origPath, 'src/util/helper.js');

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

  // A symlinked directory inside the repo pointing outside it must not let
  // saveFile write through the link, even though the literal path looks fine.
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffier-outside-'));
  fs.symlinkSync(outsideDir, path.join(tmp, 'evil-link'));
  await assert.rejects(() => gitlib.saveFile(tmp, 'evil-link/pwned.txt', 'x'));
  assert.strictEqual(fs.existsSync(path.join(outsideDir, 'pwned.txt')), false);

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
  assert.deepStrictEqual(await gitlib.log(tmp2, {}), []);
  assert.deepStrictEqual(await gitlib.stashList(tmp2), []);
  assert.strictEqual(await gitlib.aheadBehind(tmp2), null);

  // ---------------------------------------------------------- log & details
  const lg = await gitlib.log(tmp, {});
  assert.strictEqual(lg.length, 2);
  assert.strictEqual(lg[0]!.subject, 'partial commit v2');
  assert.strictEqual(lg[1]!.subject, 'seed');
  assert.strictEqual(lg[1]!.parents.length, 0, 'root commit has no parents');
  assert.strictEqual(lg[0]!.parents.length, 1);
  assert.ok(lg[0]!.refs.includes('main'));
  assert.ok(lg[0]!.time > 0);

  const paged = await gitlib.log(tmp, { skip: 1, limit: 1 });
  assert.strictEqual(paged.length, 1);
  assert.strictEqual(paged[0]!.hash, lg[1]!.hash);

  const det = await gitlib.commitDetails(tmp, lg[0]!.hash);
  assert.strictEqual(det.hash, lg[0]!.hash);
  assert.strictEqual(det.message, 'partial commit v2');
  assert.ok(det.files.some((f) => f.path === 'src/app.js'));
  const rootDet = await gitlib.commitDetails(tmp, lg[1]!.hash);
  assert.ok(rootDet.files.every((f) => f.type === 'ADDED'), 'root commit files are ADDED');

  const cfd = await gitlib.refFileDiff(tmp, `${lg[0]!.hash}^`, lg[0]!.hash, 'src/app.js', 'MODIFIED', null);
  assert.strictEqual(cfd.modified, 'edited\n');
  assert.strictEqual(cfd.original, 'line1\nline2\nline3\n');

  // File history follows the file (both commits touched src/app.js).
  const hist = await gitlib.log(tmp, { path: 'src/app.js' });
  assert.strictEqual(hist.length, 2);

  // ------------------------------------------------------ compare (two refs)
  const cmp = await gitlib.compareRefs(tmp, lg[1]!.hash, lg[0]!.hash);
  assert.ok(cmp.some((f) => f.path === 'src/app.js'), 'compareRefs missed the modified file');

  const cmpWorktree = await gitlib.compareRefs(tmp, lg[1]!.hash, null);
  assert.ok(cmpWorktree.some((f) => f.path === 'src/app.js'), 'compareRefs vs worktree missed the file');

  const refDiff = await gitlib.refFileDiff(tmp, lg[1]!.hash, lg[0]!.hash, 'src/app.js', 'MODIFIED', null);
  assert.strictEqual(refDiff.original, 'line1\nline2\nline3\n');
  assert.strictEqual(refDiff.modified, 'edited\n');

  fs.writeFileSync(path.join(tmp, 'src/app.js'), 'edited\nmore\n');
  const refDiffWorktree = await gitlib.refFileDiff(tmp, lg[0]!.hash, 'WORKTREE', 'src/app.js', 'MODIFIED', null);
  assert.strictEqual(refDiffWorktree.modified, 'edited\nmore\n');
  execFileSync('git', ['checkout', '--', 'src/app.js'], { cwd: tmp });

  // ------------------------------------------------------------- branches
  run('branch', 'feature');
  const br = await gitlib.branches(tmp);
  assert.strictEqual(br.current, 'main');
  assert.deepStrictEqual(br.locals.map((b) => b.name).sort(), ['feature', 'main']);
  assert.ok(br.locals.find((b) => b.name === 'main')!.current);
  assert.ok(!br.locals.find((b) => b.name === 'feature')!.current);

  await gitlib.checkout(tmp, 'feature');
  assert.strictEqual(await gitlib.currentBranch(tmp), 'feature');
  await gitlib.createBranch(tmp, 'experiment');
  assert.strictEqual(await gitlib.currentBranch(tmp), 'experiment');
  await gitlib.checkout(tmp, 'main');

  // A branch name starting with "-" must be rejected rather than passed
  // through to the git CLI, where it could be parsed as an option instead
  // of a positional ref argument.
  await assert.rejects(() => gitlib.checkout(tmp, '--upload-pack=x'));
  await assert.rejects(() => gitlib.createBranch(tmp, '-evil'));

  // -------------------------------------------------------- partial commit
  fs.writeFileSync(
    path.join(tmp, 'src/app.js'),
    'TOP\nmid1\nmid2\nmid3\nmid4\nmid5\nmid6\nmid7\nBOTTOM\n'
  );
  run('add', 'src/app.js');
  run('commit', '-m', 'base for partial');
  fs.writeFileSync(
    path.join(tmp, 'src/app.js'),
    'TOP-changed\nmid1\nmid2\nmid3\nmid4\nmid5\nmid6\nmid7\nBOTTOM-changed\n'
  );
  // Commit only the first hunk; the second stays a local modification.
  const partialContent =
    'TOP-changed\nmid1\nmid2\nmid3\nmid4\nmid5\nmid6\nmid7\nBOTTOM\n';
  await gitlib.commit(tmp, [], 'first hunk only', false, [
    { path: 'src/app.js', content: partialContent },
  ]);
  assert.strictEqual(run('show', 'HEAD:src/app.js'), partialContent);
  assert.strictEqual((await gitlib.lastCommitMessage(tmp)).trim(), 'first hunk only');
  const stPartial = await gitlib.status(tmp);
  const appEntry = stPartial.files.find((f) => f.path === 'src/app.js');
  assert.ok(appEntry, 'remaining hunk keeps the file modified');
  assert.strictEqual(appEntry!.type, 'MODIFIED');
  assert.strictEqual(appEntry!.xy, 'M', 'remaining change is unstaged only');

  // Mixed full + partial in one commit, and amend keeps the message/count
  // and the original author identity and date.
  const authorBefore = run('log', '-1', '--pretty=%an|%ae|%aI').trim();
  fs.writeFileSync(path.join(tmp, 'extra.txt'), 'extra\n');
  const before = Number(run('rev-list', '--count', 'HEAD').trim());
  await gitlib.commit(tmp, ['extra.txt'], '', true, [
    {
      path: 'src/app.js',
      content:
        'TOP-changed\nmid1\nmid2\nmid3\nmid4\nmid5\nmid6\nmid7\nBOTTOM-changed\n',
    },
  ]);
  assert.strictEqual((await gitlib.lastCommitMessage(tmp)).trim(), 'first hunk only');
  assert.strictEqual(Number(run('rev-list', '--count', 'HEAD').trim()), before);
  assert.strictEqual((await gitlib.status(tmp)).files.length, 0, 'clean after amend');
  assert.strictEqual(
    run('log', '-1', '--pretty=%an|%ae|%aI').trim(),
    authorBefore,
    'amend must not rewrite author identity or date'
  );

  // A partial commit whose snapshots no longer match reality is refused.
  fs.writeFileSync(path.join(tmp, 'src/app.js'), 'fresh content\n');
  await assert.rejects(
    () =>
      gitlib.commit(tmp, [], 'stale partial', false, [
        {
          path: 'src/app.js',
          content: 'prepared from old state\n',
          expectedWorktree: 'what the renderer saw\n', // != fresh content
          expectedHead: run('show', 'HEAD:src/app.js'),
        },
      ]),
    /changed on disk/
  );
  run('checkout', '--', 'src/app.js');

  // ----------------------------------------------------------------- stash
  fs.writeFileSync(path.join(tmp, 'src/app.js'), 'stashed change\n');
  fs.writeFileSync(path.join(tmp, 'wip.txt'), 'wip\n');
  await gitlib.stashPush(tmp, 'wip: test stash', true);
  assert.strictEqual((await gitlib.status(tmp)).files.length, 0);
  const stashes = await gitlib.stashList(tmp);
  assert.strictEqual(stashes.length, 1);
  assert.strictEqual(stashes[0]!.ref, 'stash@{0}');
  assert.ok(stashes[0]!.message.includes('wip: test stash'));
  assert.ok(stashes[0]!.time > 0);
  await gitlib.stashApply(tmp, 'stash@{0}');
  assert.strictEqual((await gitlib.status(tmp)).files.length, 2);
  await gitlib.rollback(tmp, (await gitlib.status(tmp)).files);
  await gitlib.stashPop(tmp, 'stash@{0}');
  assert.strictEqual((await gitlib.status(tmp)).files.length, 2);
  assert.deepStrictEqual(await gitlib.stashList(tmp), []);
  await gitlib.stashPush(tmp, 'to drop', true);
  await gitlib.stashDrop(tmp, 'stash@{0}');
  assert.deepStrictEqual(await gitlib.stashList(tmp), []);

  // ----------------------------------------------------------------- blame
  const bl = await gitlib.blame(tmp, 'src/app.js');
  assert.strictEqual(bl.length, 9);
  assert.strictEqual(bl[0]!.author, 'Test');
  assert.strictEqual(bl[0]!.sha.length, 8);
  assert.ok(!bl[0]!.uncommitted);
  fs.appendFileSync(path.join(tmp, 'src/app.js'), 'brand new line\n');
  const bl2 = await gitlib.blame(tmp, 'src/app.js');
  assert.ok(bl2[bl2.length - 1]!.uncommitted, 'appended line is uncommitted');
  run('checkout', '--', 'src/app.js');

  // -------------------------------------------------------------- conflict
  run('checkout', '-b', 'side');
  fs.writeFileSync(path.join(tmp, 'src/app.js'), 'SIDE\nmid1\nmid2\nmid3\nmid4\nmid5\nmid6\nmid7\nBOTTOM-changed\n');
  run('commit', '-am', 'side edit');
  run('checkout', 'main');
  fs.writeFileSync(path.join(tmp, 'src/app.js'), 'MAIN\nmid1\nmid2\nmid3\nmid4\nmid5\nmid6\nmid7\nBOTTOM-changed\n');
  run('commit', '-am', 'main edit');
  try {
    run('merge', 'side');
  } catch {
    /* conflict expected */
  }
  const stConf = await gitlib.status(tmp);
  assert.strictEqual(stConf.files[0]!.type, 'CONFLICT');
  const ci = await gitlib.conflictInfo(tmp, 'src/app.js');
  assert.ok(ci.ours!.startsWith('MAIN'));
  assert.ok(ci.theirs!.startsWith('SIDE'));
  assert.ok(ci.base != null, 'merge base stage present');
  assert.ok(ci.worktree.includes('<<<<<<<'));
  assert.strictEqual(ci.oursLabel, 'main');
  assert.strictEqual(ci.theirsLabel, 'side');
  await gitlib.markResolved(tmp, 'src/app.js', 'RESOLVED\n');
  assert.ok(!(await gitlib.status(tmp)).files.some((f) => f.type === 'CONFLICT'));
  // Committing while a merge concludes: git forbids pathspec-limited commits
  // here, so commit() must fall back to a whole-index merge commit.
  await gitlib.commit(tmp, ['src/app.js'], 'merge resolved', false);
  assert.strictEqual((await gitlib.lastCommitMessage(tmp)).trim(), 'merge resolved');
  // ...and per-hunk commits must be refused mid-merge rather than recording
  // a commit that silently drops the MERGE_HEAD parent.
  try {
    run('merge', '--abort');
  } catch {
    /* merge already concluded */
  }
  const mergeDet = await gitlib.commitDetails(
    tmp,
    (await gitlib.log(tmp, { limit: 1 }))[0]!.hash
  );
  assert.strictEqual(mergeDet.parents.length, 2, 'merge commit has two parents');

  // Cherry-pick conflicts hit the same pathspec restriction as merges: the
  // resolve → commit flow must fall back to a whole-index commit there too.
  run('checkout', '-b', 'pick-source');
  fs.writeFileSync(path.join(tmp, 'src/app.js'), 'PICKED\n');
  run('commit', '-am', 'pick me');
  run('checkout', 'main');
  fs.writeFileSync(path.join(tmp, 'src/app.js'), 'DIVERGED\n');
  run('commit', '-am', 'diverge');
  try {
    run('cherry-pick', 'pick-source');
  } catch {
    /* conflict expected */
  }
  assert.ok((await gitlib.status(tmp)).merging, 'cherry-pick counts as merge-like state');
  await gitlib.markResolved(tmp, 'src/app.js', 'PICK-RESOLVED\n');
  await gitlib.commit(tmp, ['src/app.js'], 'cherry-pick resolved', false);
  assert.strictEqual((await gitlib.lastCommitMessage(tmp)).trim(), 'cherry-pick resolved');
  assert.ok(!(await gitlib.status(tmp)).merging, 'sequencer state cleared by commit');

  // path escape protection on the new entry points
  await assert.rejects(() => gitlib.markResolved(tmp, '../oops.txt', 'x'));

  // -------------------------------------------------------------- imageData
  await assert.rejects(
    () => gitlib.imageData(tmp, 'src/app.js', 'MODIFIED', null),
    /Not an image/
  );
  fs.writeFileSync(path.join(tmp, 'pic.png'), Buffer.from([1, 2, 3]));
  const imgAdded = await gitlib.imageData(tmp, 'pic.png', 'ADDED', null);
  assert.strictEqual(imgAdded.imageMime, 'image/png');
  assert.strictEqual(imgAdded.originalImage, null, 'added image has no original side');
  assert.strictEqual(imgAdded.modifiedImage, Buffer.from([1, 2, 3]).toString('base64'));
  run('add', 'pic.png');
  run('commit', '-m', 'add pic');
  fs.writeFileSync(path.join(tmp, 'pic.png'), Buffer.from([9, 9, 9]));
  const imgModified = await gitlib.imageData(tmp, 'pic.png', 'MODIFIED', null);
  assert.strictEqual(imgModified.originalImage, Buffer.from([1, 2, 3]).toString('base64'));
  assert.strictEqual(imgModified.modifiedImage, Buffer.from([9, 9, 9]).toString('base64'));
  run('checkout', '--', 'pic.png');
  fs.rmSync(path.join(tmp, 'pic.png'));
  const imgDeleted = await gitlib.imageData(tmp, 'pic.png', 'DELETED', null);
  assert.strictEqual(imgDeleted.originalImage, Buffer.from([1, 2, 3]).toString('base64'));
  assert.strictEqual(imgDeleted.modifiedImage, null, 'deleted image has no modified side');
  // Commit-view lookup: explicit left/right refs pin both sides to that
  // commit's parent/self instead of HEAD/worktree.
  const picCommit = (await gitlib.log(tmp, { path: 'pic.png' }))[0]!.hash;
  const imgAtCommit = await gitlib.imageData(tmp, 'pic.png', 'ADDED', null, `${picCommit}^`, picCommit);
  assert.strictEqual(imgAtCommit.originalImage, null, 'pic.png had no parent version at the adding commit');
  assert.strictEqual(imgAtCommit.modifiedImage, Buffer.from([1, 2, 3]).toString('base64'));

  // ------------------------------------------------------------- worktree
  assert.strictEqual(await gitlib.isLinkedWorktree(tmp), false);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'diffier-wt-'));
  fs.rmSync(wt, { recursive: true });
  run('worktree', 'add', wt, 'feature');
  assert.strictEqual(await gitlib.isLinkedWorktree(wt), true);

  console.log('git.test.js OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
