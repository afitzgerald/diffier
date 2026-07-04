'use strict';
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/* Integration test for main/git.ts against a throwaway repository. */
const assert_1 = __importDefault(require("assert"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const gitlib = __importStar(require("../main/git"));
const tmp = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), 'diffier-test-'));
const run = (...args) => (0, child_process_1.execFileSync)('git', args, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString();
async function main() {
    run('init', '-b', 'main');
    run('config', 'user.email', 'test@test.local');
    run('config', 'user.name', 'Test');
    // Seed a commit.
    fs_1.default.mkdirSync(path_1.default.join(tmp, 'src/util'), { recursive: true });
    fs_1.default.writeFileSync(path_1.default.join(tmp, 'src/app.js'), 'line1\nline2\nline3\n');
    fs_1.default.writeFileSync(path_1.default.join(tmp, 'src/util/helper.js'), 'helper\n');
    fs_1.default.writeFileSync(path_1.default.join(tmp, 'gone.txt'), 'bye\n');
    run('add', '-A');
    run('commit', '-m', 'seed');
    assert_1.default.strictEqual(await gitlib.isRepo(tmp), true);
    assert_1.default.strictEqual(await gitlib.repoRoot(tmp), fs_1.default.realpathSync(tmp));
    assert_1.default.strictEqual(await gitlib.hasHead(tmp), true);
    assert_1.default.strictEqual(await gitlib.currentBranch(tmp), 'main');
    // Create every change type: modify, add(stage), delete, untracked, rename.
    fs_1.default.writeFileSync(path_1.default.join(tmp, 'src/app.js'), 'line1\nCHANGED\nline3\nline4\n');
    fs_1.default.writeFileSync(path_1.default.join(tmp, 'new-staged.txt'), 'staged new\n');
    run('add', 'new-staged.txt');
    fs_1.default.rmSync(path_1.default.join(tmp, 'gone.txt'));
    fs_1.default.writeFileSync(path_1.default.join(tmp, 'untracked.txt'), 'untracked\n');
    run('mv', 'src/util/helper.js', 'src/util/renamed.js');
    const st = await gitlib.status(tmp);
    const byPath = Object.fromEntries(st.files.map((f) => [f.path, f]));
    assert_1.default.strictEqual(byPath['src/app.js'].type, 'MODIFIED');
    assert_1.default.strictEqual(byPath['new-staged.txt'].type, 'ADDED');
    assert_1.default.strictEqual(byPath['gone.txt'].type, 'DELETED');
    assert_1.default.strictEqual(byPath['untracked.txt'].type, 'UNVERSIONED');
    assert_1.default.strictEqual(byPath['src/util/renamed.js'].type, 'MOVED');
    assert_1.default.strictEqual(byPath['src/util/renamed.js'].origPath, 'src/util/helper.js');
    // Diffs.
    const mod = await gitlib.fileDiff(tmp, 'src/app.js', 'MODIFIED', null);
    assert_1.default.strictEqual(mod.original, 'line1\nline2\nline3\n');
    assert_1.default.strictEqual(mod.modified, 'line1\nCHANGED\nline3\nline4\n');
    assert_1.default.strictEqual(mod.binary, false);
    const del = await gitlib.fileDiff(tmp, 'gone.txt', 'DELETED', null);
    assert_1.default.strictEqual(del.original, 'bye\n');
    assert_1.default.strictEqual(del.modified, '');
    const untracked = await gitlib.fileDiff(tmp, 'untracked.txt', 'UNVERSIONED', null);
    assert_1.default.strictEqual(untracked.original, '');
    assert_1.default.strictEqual(untracked.modified, 'untracked\n');
    const ren = await gitlib.fileDiff(tmp, 'src/util/renamed.js', 'MOVED', 'src/util/helper.js');
    assert_1.default.strictEqual(ren.original, 'helper\n');
    assert_1.default.strictEqual(ren.modified, 'helper\n');
    // Binary detection.
    fs_1.default.writeFileSync(path_1.default.join(tmp, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    const bin = await gitlib.fileDiff(tmp, 'bin.dat', 'UNVERSIONED', null);
    assert_1.default.strictEqual(bin.binary, true);
    // Path escape protection.
    await assert_1.default.rejects(() => gitlib.fileDiff(tmp, '../etc/passwd', 'MODIFIED', null));
    await assert_1.default.rejects(() => gitlib.saveFile(tmp, '../oops.txt', 'x'));
    // Save.
    await gitlib.saveFile(tmp, 'src/app.js', 'edited\n');
    assert_1.default.strictEqual(fs_1.default.readFileSync(path_1.default.join(tmp, 'src/app.js'), 'utf8'), 'edited\n');
    // Partial commit: only two of the changed files.
    await gitlib.commit(tmp, ['src/app.js', 'new-staged.txt'], 'partial commit', false);
    const st2 = await gitlib.status(tmp);
    const paths2 = st2.files.map((f) => f.path).sort();
    assert_1.default.ok(!paths2.includes('src/app.js'), 'committed file still dirty');
    assert_1.default.ok(!paths2.includes('new-staged.txt'), 'committed file still dirty');
    assert_1.default.ok(paths2.includes('gone.txt'), 'uncommitted deletion lost');
    assert_1.default.ok(paths2.includes('untracked.txt'), 'untracked file lost');
    assert_1.default.strictEqual(await gitlib.lastCommitMessage(tmp), 'partial commit');
    // Amend.
    await gitlib.commit(tmp, ['untracked.txt'], 'partial commit v2', true);
    assert_1.default.strictEqual(await gitlib.lastCommitMessage(tmp), 'partial commit v2');
    assert_1.default.strictEqual(run('rev-list', '--count', 'HEAD').trim(), '2');
    // Rollback: deletion restored, rename undone, unversioned deleted.
    fs_1.default.writeFileSync(path_1.default.join(tmp, 'junk.txt'), 'junk\n');
    const st3 = await gitlib.status(tmp);
    await gitlib.rollback(tmp, st3.files);
    const st4 = await gitlib.status(tmp);
    assert_1.default.strictEqual(st4.files.length, 0, 'rollback left changes: ' + JSON.stringify(st4.files));
    assert_1.default.ok(fs_1.default.existsSync(path_1.default.join(tmp, 'gone.txt')), 'deleted file not restored');
    assert_1.default.ok(fs_1.default.existsSync(path_1.default.join(tmp, 'src/util/helper.js')), 'rename not undone');
    assert_1.default.ok(!fs_1.default.existsSync(path_1.default.join(tmp, 'src/util/renamed.js')), 'renamed file still present');
    assert_1.default.ok(!fs_1.default.existsSync(path_1.default.join(tmp, 'junk.txt')), 'unversioned file not deleted');
    // Empty-repo edge case (no HEAD yet).
    const tmp2 = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), 'diffier-test2-'));
    (0, child_process_1.execFileSync)('git', ['init', '-b', 'main'], { cwd: tmp2 });
    const stEmpty = await gitlib.status(tmp2);
    assert_1.default.strictEqual(stEmpty.hasHead, false);
    assert_1.default.strictEqual(stEmpty.files.length, 0);
    assert_1.default.deepStrictEqual(await gitlib.log(tmp2, {}), []);
    assert_1.default.deepStrictEqual(await gitlib.stashList(tmp2), []);
    assert_1.default.strictEqual(await gitlib.aheadBehind(tmp2), null);
    // ---------------------------------------------------------- log & details
    const lg = await gitlib.log(tmp, {});
    assert_1.default.strictEqual(lg.length, 2);
    assert_1.default.strictEqual(lg[0].subject, 'partial commit v2');
    assert_1.default.strictEqual(lg[1].subject, 'seed');
    assert_1.default.strictEqual(lg[1].parents.length, 0, 'root commit has no parents');
    assert_1.default.strictEqual(lg[0].parents.length, 1);
    assert_1.default.ok(lg[0].refs.includes('main'));
    assert_1.default.ok(lg[0].time > 0);
    const paged = await gitlib.log(tmp, { skip: 1, limit: 1 });
    assert_1.default.strictEqual(paged.length, 1);
    assert_1.default.strictEqual(paged[0].hash, lg[1].hash);
    const det = await gitlib.commitDetails(tmp, lg[0].hash);
    assert_1.default.strictEqual(det.hash, lg[0].hash);
    assert_1.default.strictEqual(det.message, 'partial commit v2');
    assert_1.default.ok(det.files.some((f) => f.path === 'src/app.js'));
    const rootDet = await gitlib.commitDetails(tmp, lg[1].hash);
    assert_1.default.ok(rootDet.files.every((f) => f.type === 'ADDED'), 'root commit files are ADDED');
    const cfd = await gitlib.commitFileDiff(tmp, lg[0].hash, 'src/app.js', 'MODIFIED', null);
    assert_1.default.strictEqual(cfd.modified, 'edited\n');
    assert_1.default.strictEqual(cfd.original, 'line1\nline2\nline3\n');
    // File history follows the file (both commits touched src/app.js).
    const hist = await gitlib.log(tmp, { path: 'src/app.js' });
    assert_1.default.strictEqual(hist.length, 2);
    // ------------------------------------------------------------- branches
    run('branch', 'feature');
    const br = await gitlib.branches(tmp);
    assert_1.default.strictEqual(br.current, 'main');
    assert_1.default.deepStrictEqual(br.locals.map((b) => b.name).sort(), ['feature', 'main']);
    assert_1.default.ok(br.locals.find((b) => b.name === 'main').current);
    assert_1.default.ok(!br.locals.find((b) => b.name === 'feature').current);
    await gitlib.checkout(tmp, 'feature');
    assert_1.default.strictEqual(await gitlib.currentBranch(tmp), 'feature');
    await gitlib.createBranch(tmp, 'experiment');
    assert_1.default.strictEqual(await gitlib.currentBranch(tmp), 'experiment');
    await gitlib.checkout(tmp, 'main');
    // A branch name starting with "-" must be rejected rather than passed
    // through to the git CLI, where it could be parsed as an option instead
    // of a positional ref argument.
    await assert_1.default.rejects(() => gitlib.checkout(tmp, '--upload-pack=x'));
    await assert_1.default.rejects(() => gitlib.createBranch(tmp, '-evil'));
    // -------------------------------------------------------- partial commit
    fs_1.default.writeFileSync(path_1.default.join(tmp, 'src/app.js'), 'TOP\nmid1\nmid2\nmid3\nmid4\nmid5\nmid6\nmid7\nBOTTOM\n');
    run('add', 'src/app.js');
    run('commit', '-m', 'base for partial');
    fs_1.default.writeFileSync(path_1.default.join(tmp, 'src/app.js'), 'TOP-changed\nmid1\nmid2\nmid3\nmid4\nmid5\nmid6\nmid7\nBOTTOM-changed\n');
    // Commit only the first hunk; the second stays a local modification.
    const partialContent = 'TOP-changed\nmid1\nmid2\nmid3\nmid4\nmid5\nmid6\nmid7\nBOTTOM\n';
    await gitlib.commit(tmp, [], 'first hunk only', false, [
        { path: 'src/app.js', content: partialContent },
    ]);
    assert_1.default.strictEqual(run('show', 'HEAD:src/app.js'), partialContent);
    assert_1.default.strictEqual((await gitlib.lastCommitMessage(tmp)).trim(), 'first hunk only');
    const stPartial = await gitlib.status(tmp);
    const appEntry = stPartial.files.find((f) => f.path === 'src/app.js');
    assert_1.default.ok(appEntry, 'remaining hunk keeps the file modified');
    assert_1.default.strictEqual(appEntry.type, 'MODIFIED');
    assert_1.default.strictEqual(appEntry.xy, 'M', 'remaining change is unstaged only');
    // Mixed full + partial in one commit, and amend keeps the message/count
    // and the original author identity and date.
    const authorBefore = run('log', '-1', '--pretty=%an|%ae|%aI').trim();
    fs_1.default.writeFileSync(path_1.default.join(tmp, 'extra.txt'), 'extra\n');
    const before = Number(run('rev-list', '--count', 'HEAD').trim());
    await gitlib.commit(tmp, ['extra.txt'], '', true, [
        {
            path: 'src/app.js',
            content: 'TOP-changed\nmid1\nmid2\nmid3\nmid4\nmid5\nmid6\nmid7\nBOTTOM-changed\n',
        },
    ]);
    assert_1.default.strictEqual((await gitlib.lastCommitMessage(tmp)).trim(), 'first hunk only');
    assert_1.default.strictEqual(Number(run('rev-list', '--count', 'HEAD').trim()), before);
    assert_1.default.strictEqual((await gitlib.status(tmp)).files.length, 0, 'clean after amend');
    assert_1.default.strictEqual(run('log', '-1', '--pretty=%an|%ae|%aI').trim(), authorBefore, 'amend must not rewrite author identity or date');
    // A partial commit whose snapshots no longer match reality is refused.
    fs_1.default.writeFileSync(path_1.default.join(tmp, 'src/app.js'), 'fresh content\n');
    await assert_1.default.rejects(() => gitlib.commit(tmp, [], 'stale partial', false, [
        {
            path: 'src/app.js',
            content: 'prepared from old state\n',
            expectedWorktree: 'what the renderer saw\n', // != fresh content
            expectedHead: run('show', 'HEAD:src/app.js'),
        },
    ]), /changed on disk/);
    run('checkout', '--', 'src/app.js');
    // ----------------------------------------------------------------- stash
    fs_1.default.writeFileSync(path_1.default.join(tmp, 'src/app.js'), 'stashed change\n');
    fs_1.default.writeFileSync(path_1.default.join(tmp, 'wip.txt'), 'wip\n');
    await gitlib.stashPush(tmp, 'wip: test stash', true);
    assert_1.default.strictEqual((await gitlib.status(tmp)).files.length, 0);
    const stashes = await gitlib.stashList(tmp);
    assert_1.default.strictEqual(stashes.length, 1);
    assert_1.default.strictEqual(stashes[0].ref, 'stash@{0}');
    assert_1.default.ok(stashes[0].message.includes('wip: test stash'));
    assert_1.default.ok(stashes[0].time > 0);
    await gitlib.stashApply(tmp, 'stash@{0}');
    assert_1.default.strictEqual((await gitlib.status(tmp)).files.length, 2);
    await gitlib.rollback(tmp, (await gitlib.status(tmp)).files);
    await gitlib.stashPop(tmp, 'stash@{0}');
    assert_1.default.strictEqual((await gitlib.status(tmp)).files.length, 2);
    assert_1.default.deepStrictEqual(await gitlib.stashList(tmp), []);
    await gitlib.stashPush(tmp, 'to drop', true);
    await gitlib.stashDrop(tmp, 'stash@{0}');
    assert_1.default.deepStrictEqual(await gitlib.stashList(tmp), []);
    // ----------------------------------------------------------------- blame
    const bl = await gitlib.blame(tmp, 'src/app.js');
    assert_1.default.strictEqual(bl.length, 9);
    assert_1.default.strictEqual(bl[0].author, 'Test');
    assert_1.default.strictEqual(bl[0].sha.length, 8);
    assert_1.default.ok(!bl[0].uncommitted);
    fs_1.default.appendFileSync(path_1.default.join(tmp, 'src/app.js'), 'brand new line\n');
    const bl2 = await gitlib.blame(tmp, 'src/app.js');
    assert_1.default.ok(bl2[bl2.length - 1].uncommitted, 'appended line is uncommitted');
    run('checkout', '--', 'src/app.js');
    // -------------------------------------------------------------- conflict
    run('checkout', '-b', 'side');
    fs_1.default.writeFileSync(path_1.default.join(tmp, 'src/app.js'), 'SIDE\nmid1\nmid2\nmid3\nmid4\nmid5\nmid6\nmid7\nBOTTOM-changed\n');
    run('commit', '-am', 'side edit');
    run('checkout', 'main');
    fs_1.default.writeFileSync(path_1.default.join(tmp, 'src/app.js'), 'MAIN\nmid1\nmid2\nmid3\nmid4\nmid5\nmid6\nmid7\nBOTTOM-changed\n');
    run('commit', '-am', 'main edit');
    try {
        run('merge', 'side');
    }
    catch {
        /* conflict expected */
    }
    const stConf = await gitlib.status(tmp);
    assert_1.default.strictEqual(stConf.files[0].type, 'CONFLICT');
    const ci = await gitlib.conflictInfo(tmp, 'src/app.js');
    assert_1.default.ok(ci.ours.startsWith('MAIN'));
    assert_1.default.ok(ci.theirs.startsWith('SIDE'));
    assert_1.default.ok(ci.base != null, 'merge base stage present');
    assert_1.default.ok(ci.worktree.includes('<<<<<<<'));
    assert_1.default.strictEqual(ci.oursLabel, 'main');
    assert_1.default.strictEqual(ci.theirsLabel, 'side');
    await gitlib.markResolved(tmp, 'src/app.js', 'RESOLVED\n');
    assert_1.default.ok(!(await gitlib.status(tmp)).files.some((f) => f.type === 'CONFLICT'));
    // Committing while a merge concludes: git forbids pathspec-limited commits
    // here, so commit() must fall back to a whole-index merge commit.
    await gitlib.commit(tmp, ['src/app.js'], 'merge resolved', false);
    assert_1.default.strictEqual((await gitlib.lastCommitMessage(tmp)).trim(), 'merge resolved');
    // ...and per-hunk commits must be refused mid-merge rather than recording
    // a commit that silently drops the MERGE_HEAD parent.
    try {
        run('merge', '--abort');
    }
    catch {
        /* merge already concluded */
    }
    const mergeDet = await gitlib.commitDetails(tmp, (await gitlib.log(tmp, { limit: 1 }))[0].hash);
    assert_1.default.strictEqual(mergeDet.parents.length, 2, 'merge commit has two parents');
    // Cherry-pick conflicts hit the same pathspec restriction as merges: the
    // resolve → commit flow must fall back to a whole-index commit there too.
    run('checkout', '-b', 'pick-source');
    fs_1.default.writeFileSync(path_1.default.join(tmp, 'src/app.js'), 'PICKED\n');
    run('commit', '-am', 'pick me');
    run('checkout', 'main');
    fs_1.default.writeFileSync(path_1.default.join(tmp, 'src/app.js'), 'DIVERGED\n');
    run('commit', '-am', 'diverge');
    try {
        run('cherry-pick', 'pick-source');
    }
    catch {
        /* conflict expected */
    }
    assert_1.default.ok((await gitlib.status(tmp)).merging, 'cherry-pick counts as merge-like state');
    await gitlib.markResolved(tmp, 'src/app.js', 'PICK-RESOLVED\n');
    await gitlib.commit(tmp, ['src/app.js'], 'cherry-pick resolved', false);
    assert_1.default.strictEqual((await gitlib.lastCommitMessage(tmp)).trim(), 'cherry-pick resolved');
    assert_1.default.ok(!(await gitlib.status(tmp)).merging, 'sequencer state cleared by commit');
    // path escape protection on the new entry points
    await assert_1.default.rejects(() => gitlib.markResolved(tmp, '../oops.txt', 'x'));
    // ------------------------------------------------------------- worktree
    assert_1.default.strictEqual(await gitlib.isLinkedWorktree(tmp), false);
    const wt = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), 'diffier-wt-'));
    fs_1.default.rmSync(wt, { recursive: true });
    run('worktree', 'add', wt, 'feature');
    assert_1.default.strictEqual(await gitlib.isLinkedWorktree(wt), true);
    console.log('git.test.js OK');
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
