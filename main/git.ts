'use strict';

import { execFile } from 'child_process';
import type { ExecFileOptionsWithBufferEncoding, ExecFileOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileP = promisify(execFile);
import type {
  AheadBehind,
  BlameLine,
  BranchEntry,
  BranchesResult,
  ChangeType,
  CommitDetails,
  CommitFile,
  ConflictInfoResult,
  DiffPayload,
  DiffStat,
  FileDiffResult,
  FileEntry,
  ImageDataResult,
  LogEntry,
  LogOptions,
  PartialCommitFile,
  StashEntry,
  StatusResult,
} from './git-types';

// Re-exported so existing `import type {...} from './git'` call sites (main
// process, tests) keep working — see git-types.ts for why the definitions
// themselves live in a separate, Node-free file.
export type {
  AheadBehind,
  BlameLine,
  BranchEntry,
  BranchesResult,
  ChangeType,
  CommitDetails,
  CommitFile,
  ConflictInfoResult,
  DiffPayload,
  DiffStat,
  FileDiffResult,
  FileEntry,
  ImageDataResult,
  LogEntry,
  LogOptions,
  PartialCommitFile,
  StashEntry,
  StatusResult,
};

const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_DIFF_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

interface GitExecOpts {
  env?: NodeJS.ProcessEnv;
  stdin?: string;
}

// -------------------------------------------------------------------- exec

function gitOpts(cwd: string, args: string[], opts: GitExecOpts & { encoding: 'buffer' }): Promise<Buffer>;
function gitOpts(cwd: string, args: string[], opts?: GitExecOpts): Promise<string>;
async function gitOpts(
  cwd: string,
  args: string[],
  opts: (GitExecOpts & { encoding?: 'buffer' }) | undefined
): Promise<string | Buffer> {
  const execOpts = { cwd, maxBuffer: MAX_BUFFER, ...opts } as
    | ExecFileOptionsWithStringEncoding
    | ExecFileOptionsWithBufferEncoding;
  const promise = execFileP('git', args, execOpts as ExecFileOptionsWithStringEncoding);
  if (opts && opts.stdin != null) {
    const child = (promise as unknown as { child: import('child_process').ChildProcess }).child;
    // A child that exits before draining stdin makes this write emit EPIPE;
    // without a listener the stream throws and kills the main process. The
    // rejection below still reports the real failure.
    child.stdin!.on('error', () => {});
    child.stdin!.end(opts.stdin);
  }
  try {
    return (await promise).stdout as string | Buffer;
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message: string };
    const msg =
      (e.stderr && e.stderr.toString().trim()) || (e.stdout && e.stdout.toString().trim()) || e.message;
    throw new Error(msg);
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return gitOpts(cwd, args);
}

// Binary-safe variant: stdout as a Buffer.
function gitRaw(cwd: string, args: string[]): Promise<Buffer> {
  return gitOpts(cwd, args, { encoding: 'buffer' });
}

export async function isRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

export async function repoRoot(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
}

export async function hasHead(root: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

export async function currentBranch(root: string): Promise<string> {
  try {
    return (await git(root, ['symbolic-ref', '--short', 'HEAD'])).trim();
  } catch {
    try {
      return (await git(root, ['rev-parse', '--short', 'HEAD'])).trim() + ' (detached)';
    } catch {
      return '(no branch)';
    }
  }
}

// Map porcelain XY codes to an IntelliJ-style change type.
export function changeType(x: string, y: string): ChangeType {
  if (x === '?' || y === '?') return 'UNVERSIONED';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'CONFLICT';
  if (x === 'R' || y === 'R') return 'MOVED';
  if (x === 'A' || y === 'A') return 'ADDED';
  if (x === 'D' || y === 'D') return 'DELETED';
  return 'MODIFIED';
}

// Parse `git status --porcelain=v1 -z` output. Rename entries are followed
// by the original path as a separate NUL-terminated token.
export function parseStatusZ(out: string): FileEntry[] {
  const tokens = out.split('\0').filter((t) => t.length > 0);
  const files: FileEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const x = t[0]!;
    const y = t[1]!;
    const p = t.slice(3);
    const entry: FileEntry = { path: p, origPath: null, type: changeType(x, y), xy: (x + y).trim() };
    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') {
      entry.origPath = tokens[++i] || null;
    }
    files.push(entry);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

// Parse `--pretty=format:...%x01` output: SOH-terminated records of
// NUL-separated fields. Newlines between records (git adds one) are part of
// the previous terminator, not data.
function parseRecords(out: string): string[][] {
  return out
    .split('\x01')
    .map((rec) => rec.replace(/^\n/, ''))
    .filter(Boolean)
    .map((rec) => rec.split('\0'));
}

// Combined staged+unstaged line totals vs HEAD (matches the worktree diff
// shown per file). Untracked files aren't counted — git diff --numstat only
// covers tracked paths, and there's no HEAD to diff an untracked file against.
async function diffStat(root: string, hasHeadRef: boolean): Promise<DiffStat | null> {
  if (!hasHeadRef) return null;
  const out = await git(root, ['diff', 'HEAD', '--numstat', '-z']);
  let added = 0;
  let removed = 0;
  for (const line of out.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    if (m[1] !== '-') added += Number(m[1]);
    if (m[2] !== '-') removed += Number(m[2]);
  }
  return { added, removed };
}

export async function status(root: string): Promise<StatusResult> {
  const [out, branch, head, track, merging] = await Promise.all([
    // --no-optional-locks: status may not take index.lock (it opportunistically
    // refreshes the stat cache) — a concurrent real write (stash pop, commit)
    // would fail on the lock. Status is called from pollers, so keep it read-only.
    git(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']),
    currentBranch(root),
    hasHead(root),
    aheadBehind(root),
    mergeInProgress(root),
  ]);
  return {
    branch,
    hasHead: head,
    files: parseStatusZ(out),
    track,
    merging,
    diffStat: await diffStat(root, head),
  };
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// Blob content at any ref (empty buffer when the path doesn't exist there).
async function showFileAt(root: string, ref: string, relPath: string): Promise<Buffer> {
  try {
    return await gitRaw(root, ['show', `${ref}:${relPath}`]);
  } catch {
    return Buffer.alloc(0);
  }
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

function imageMime(relPath: string): string | null {
  return IMAGE_MIME[path.extname(relPath).toLowerCase()] || null;
}

// Classify a pair of file versions into the diff payload shape shared by
// fileDiff (HEAD vs worktree) and commitFileDiff (parent vs commit): binary
// with an optional side-by-side image preview, too large, or plain text
// (SVGs additionally carry an image payload for the preview toggle).
function classifyDiff(origBuf: Buffer, modBuf: Buffer, relPath: string): DiffPayload {
  const mime = imageMime(relPath);
  const imagePayload = () => ({
    image: true,
    imageMime: mime,
    originalImage: origBuf.length ? origBuf.toString('base64') : null,
    modifiedImage: modBuf.length ? modBuf.toString('base64') : null,
  });
  if (looksBinary(origBuf) || looksBinary(modBuf)) {
    if (mime && origBuf.length <= MAX_IMAGE_BYTES && modBuf.length <= MAX_IMAGE_BYTES) {
      return { binary: true, original: '', modified: '', ...imagePayload() };
    }
    return { binary: true, original: '', modified: '' };
  }
  if (origBuf.length > MAX_DIFF_BYTES || modBuf.length > MAX_DIFF_BYTES) {
    return { tooLarge: true, binary: false, original: '', modified: '' };
  }
  const result: DiffPayload = {
    binary: false,
    original: origBuf.toString('utf8'),
    modified: modBuf.toString('utf8'),
  };
  // SVGs diff as text; the preview toggle fetches the image payload on
  // demand via imageData() instead of shipping base64 with every refresh.
  if (mime === 'image/svg+xml') {
    result.image = true;
    result.imageMime = mime;
  }
  return result;
}

// On-demand image payloads for the preview toggle. `leftRef` defaults to HEAD
// (worktree tab); `rightRef` absent or 'WORKTREE' reads the disk file,
// otherwise reads that ref's blob (Log/Compare tab).
export async function imageData(
  root: string,
  relPath: string,
  type: ChangeType,
  origPath: string | null,
  leftRef?: string | null,
  rightRef?: string | null
): Promise<ImageDataResult> {
  const abs = insideRepo(root, relPath);
  const mime = imageMime(relPath);
  if (!mime) throw new Error('Not an image: ' + relPath);
  let origBuf: Buffer = Buffer.alloc(0);
  if (type !== 'ADDED' && type !== 'UNVERSIONED') {
    origBuf = await showFileAt(root, leftRef || 'HEAD', origPath || relPath);
  }
  let modBuf: Buffer = Buffer.alloc(0);
  if (type !== 'DELETED') {
    if (rightRef && rightRef !== 'WORKTREE') {
      modBuf = await showFileAt(root, rightRef, relPath);
    } else {
      try {
        modBuf = await fs.readFile(abs);
      } catch {
        /* deleted from worktree */
      }
    }
  }
  if (origBuf.length > MAX_IMAGE_BYTES || modBuf.length > MAX_IMAGE_BYTES) {
    throw new Error('Image is too large to preview');
  }
  return {
    imageMime: mime,
    originalImage: origBuf.length ? origBuf.toString('base64') : null,
    modifiedImage: modBuf.length ? modBuf.toString('base64') : null,
  };
}

// HEAD version vs. working-tree version of one file (IntelliJ's default
// "compare with local" for the commit tool window).
export async function fileDiff(
  root: string,
  relPath: string,
  type: ChangeType,
  origPath: string | null
): Promise<FileDiffResult> {
  const abs = insideRepo(root, relPath);

  let origBuf: Buffer = Buffer.alloc(0);
  if (type !== 'ADDED' && type !== 'UNVERSIONED') {
    origBuf = await showFileAt(root, 'HEAD', origPath || relPath);
  }

  let modBuf: Buffer = Buffer.alloc(0);
  if (type !== 'DELETED') {
    try {
      modBuf = await fs.readFile(abs);
    } catch {
      modBuf = Buffer.alloc(0);
    }
  }

  return { ...classifyDiff(origBuf, modBuf, relPath), absPath: abs };
}

// Resolve relPath inside the repository or throw.
function insideRepo(root: string, relPath: string): string {
  const abs = path.join(root, relPath);
  if (path.relative(root, abs).startsWith('..')) {
    throw new Error('Path escapes repository root');
  }
  return abs;
}

// A ref name that starts with "-" would be parsed as an option by the git
// CLI instead of a positional argument — reject rather than risk option
// injection from an untrusted branch/tag name (e.g. one pulled from a
// remote the user doesn't control).
function assertNotOption(value: string, label: string): void {
  if (value.startsWith('-')) {
    throw new Error(`${label} must not start with "-": ${value}`);
  }
}

export async function saveFile(root: string, relPath: string, content: string): Promise<void> {
  const abs = insideRepo(root, relPath);
  // insideRepo only checks the literal path; a symlinked parent directory
  // could still resolve outside root, so verify the real (symlink-resolved)
  // parent stays under the real root before writing.
  const realRoot = await fs.realpath(root);
  const realParent = await fs.realpath(path.dirname(abs));
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
    throw new Error('Path escapes repository root');
  }
  await fs.writeFile(abs, content, 'utf8');
}

// Merge, cherry-pick, or revert concluding: git forbids pathspec-limited
// commits during all three ("cannot do a partial commit during a ...").
async function mergeInProgress(root: string): Promise<boolean> {
  const present = await Promise.all(
    ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].map((ref) =>
      git(root, ['rev-parse', '--verify', '--quiet', ref]).then(
        () => true,
        () => false
      )
    )
  );
  return present.some(Boolean);
}

export async function commit(
  root: string,
  files: string[],
  message: string,
  amend: boolean,
  partials: PartialCommitFile[] = []
): Promise<string> {
  if (!files.length && !partials.length) throw new Error('No files selected for commit');
  if (!message.trim() && !amend) throw new Error('Commit message is empty');
  const merging = await mergeInProgress(root);
  if (partials.length) {
    if (merging) {
      throw new Error('Per-hunk commits are not available while a merge is in progress');
    }
    return commitWithPartials(root, files, partials, message, amend);
  }
  await git(root, ['add', '-A', '--', ...files]);
  // Pathspec-limited commit: only the selected files are committed, even if
  // other changes happen to be staged (e.g. by git mv or a CLI `git add`).
  // Exception: git forbids partial commits while concluding a merge, so a
  // merge commit records the whole index (like IntelliJ's merge commit).
  const args = ['commit'];
  if (amend) args.push('--amend');
  if (message.trim()) args.push('-m', message);
  else args.push('--no-edit');
  if (!merging) args.push('--', ...files);
  return git(root, args);
}

// Commit where some files contribute only a subset of their hunks. The
// renderer sends, per partial file, the exact content to commit (HEAD content
// plus the checked hunks). Committing goes through a temporary index so the
// user's real index and working tree are untouched except for the recorded
// commit: read HEAD's tree, overlay fully-selected files from the working
// tree and partial files from the provided content, write the tree, create
// the commit object, advance HEAD, then sync the real index for the involved
// paths (the unchecked hunks remain as local modifications).
async function commitWithPartials(
  root: string,
  fullFiles: string[],
  partials: PartialCommitFile[],
  message: string,
  amend: boolean
): Promise<string> {
  const head = await hasHead(root);
  let msg = message.trim();
  if (!msg) {
    if (!amend || !head) throw new Error('Commit message is empty');
    msg = await lastCommitMessage(root);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'diffier-idx-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(tmpDir, 'index') };
  const gitIdx = (args: string[], opts?: GitExecOpts) => gitOpts(root, args, { env, ...opts });
  try {
    await gitIdx(head ? ['read-tree', 'HEAD'] : ['read-tree', '--empty']);
    if (fullFiles.length) await gitIdx(['add', '-A', '--', ...fullFiles]);
    for (const p of partials) {
      const abs = insideRepo(root, p.path);
      // The hunk selection was prepared against a snapshot of the file and
      // of HEAD. Verify both here, where the commit is recorded, so no
      // renderer-side race can commit stale prepared content.
      if (typeof p.expectedWorktree === 'string') {
        let cur = '';
        try {
          cur = await fs.readFile(abs, 'utf8');
        } catch {
          /* treated as mismatch below */
        }
        if (cur !== p.expectedWorktree) {
          throw new Error(`${p.path} changed on disk since its hunks were selected — reopen it and reselect`);
        }
      }
      if (typeof p.expectedHead === 'string') {
        const headNow = (await showFileAt(root, 'HEAD', p.path)).toString('utf8');
        if (headNow !== p.expectedHead) {
          throw new Error(`${p.path} changed in HEAD since its hunks were selected — reopen it and reselect`);
        }
      }
      // --path applies .gitattributes filters (eol normalization, clean
      // filters such as LFS) exactly as `git add` would.
      const sha = (
        await gitIdx(['hash-object', '-w', '--stdin', '--path', p.path], { stdin: p.content })
      ).trim();
      let mode = '100644';
      try {
        const st = await fs.stat(abs);
        if (st.mode & 0o111) mode = '100755';
      } catch {
        /* keep default mode */
      }
      await gitIdx(['update-index', '--add', '--cacheinfo', `${mode},${sha},${p.path}`]);
    }
    const tree = (await gitIdx(['write-tree'])).trim();

    let parents: string[] = [];
    let oldHead: string | undefined;
    const commitEnv: NodeJS.ProcessEnv = { ...process.env };
    if (head) {
      oldHead = (await git(root, ['rev-parse', 'HEAD'])).trim();
      if (amend) {
        parents = (await git(root, ['log', '-1', '--pretty=%P'])).trim().split(' ').filter(Boolean);
        // Amending must not rewrite who wrote the commit, or when.
        const [an, ae, ad] = (await git(root, ['log', '-1', '--pretty=%an%x00%ae%x00%aI']))
          .trim()
          .split('\0');
        commitEnv.GIT_AUTHOR_NAME = an;
        commitEnv.GIT_AUTHOR_EMAIL = ae;
        commitEnv.GIT_AUTHOR_DATE = ad;
      } else {
        parents = [oldHead];
      }
    }
    const ctArgs = ['commit-tree', tree];
    for (const p of parents) ctArgs.push('-p', p);
    ctArgs.push('-m', msg);
    const newCommit = (await gitOpts(root, ctArgs, { env: commitEnv })).trim();
    const updateRefArgs = [
      'update-ref', '-m', amend ? 'commit (amend): ' + msg.split('\n')[0] : 'commit: ' + msg.split('\n')[0],
      'HEAD', newCommit,
    ];
    // Pass HEAD's pre-commit value as update-ref's expected old value so a
    // concurrent change to HEAD (another commit, a checkout) aborts this
    // update instead of silently overwriting it.
    if (oldHead) updateRefArgs.push(oldHead);
    await git(root, updateRefArgs);
    // Sync the real index to the new HEAD for the committed paths so the
    // remaining (unchecked) hunks show up as plain unstaged modifications.
    const touched = [...fullFiles, ...partials.map((p) => p.path)];
    if (touched.length) await git(root, ['reset', '--quiet', '--', ...touched]).catch(() => {});
    return newCommit;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export async function lastCommitMessage(root: string): Promise<string> {
  try {
    return (await git(root, ['log', '-1', '--pretty=%B'])).trimEnd();
  } catch {
    return '';
  }
}

// IntelliJ "Rollback": tracked files go back to HEAD, newly added files
// become unversioned again, unversioned files are deleted.
export async function rollback(root: string, files: FileEntry[]): Promise<void> {
  const head = await hasHead(root);
  for (const f of files) {
    let abs: string;
    try {
      abs = insideRepo(root, f.path);
    } catch {
      continue;
    }
    if (f.type === 'UNVERSIONED') {
      await fs.rm(abs, { force: true });
    } else if (f.type === 'ADDED' || !head) {
      await git(root, ['rm', '--cached', '-f', '--', f.path]).catch(() => {});
    } else {
      if (f.origPath) {
        // Undo a rename: restore the original, drop the new path.
        await git(root, ['rm', '--cached', '-f', '--', f.path]).catch(() => {});
        await fs.rm(abs, { force: true });
        await git(root, ['checkout', 'HEAD', '--', f.origPath]);
      } else {
        await git(root, ['checkout', 'HEAD', '--', f.path]);
      }
    }
  }
}

// ---------------------------------------------------------------- branches

export async function branches(root: string): Promise<BranchesResult> {
  const locals: BranchEntry[] = [];
  const remotes: string[] = [];
  try {
    // One subprocess for both namespaces; %(HEAD) marks the current branch.
    const out = await git(root, [
      'for-each-ref',
      '--format=%(HEAD)%00%(refname)%00%(refname:short)%00%(upstream:short)%00%(upstream:track)%00%(objectname:short)%01',
      '--sort=-committerdate',
      'refs/heads',
      'refs/remotes',
    ]);
    for (const [head, ref, name, upstream, track, sha] of parseRecords(out)) {
      if (ref!.startsWith('refs/heads/')) {
        locals.push({
          name: name!,
          current: head === '*',
          upstream: upstream || null,
          track: track || '',
          sha: sha!,
        });
      } else if (!ref!.endsWith('/HEAD')) {
        remotes.push(name!);
      }
    }
  } catch {
    /* empty repo */
  }
  const cur = locals.find((b) => b.current);
  return {
    // Detached HEAD / empty repo has no %(HEAD)-marked branch — fall back.
    current: cur ? cur.name : await currentBranch(root),
    locals,
    remotes,
  };
}

export async function checkout(root: string, name: string): Promise<string> {
  assertNotOption(name, 'Branch name');
  // Plain name checkout DWIMs remote branches into local tracking branches.
  return git(root, ['checkout', name]);
}

export async function createBranch(root: string, name: string): Promise<string> {
  assertNotOption(name, 'Branch name');
  return git(root, ['checkout', '-b', name]);
}

export async function pull(root: string): Promise<string> {
  return git(root, ['pull']);
}

export async function fetch(root: string): Promise<string> {
  return git(root, ['fetch', '--all', '--prune']);
}

// How far the current branch is from its upstream: { ahead, behind } or null.
export async function aheadBehind(root: string): Promise<AheadBehind | null> {
  try {
    const out = await git(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
    const [behind, ahead] = out.trim().split(/\s+/).map(Number);
    return { ahead: ahead!, behind: behind! };
  } catch {
    return null;
  }
}

// Linked worktrees have a per-worktree git dir under <main>/.git/worktrees/.
export async function isLinkedWorktree(root: string): Promise<boolean> {
  try {
    const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
    const commonDir = (await git(root, ['rev-parse', '--git-common-dir'])).trim();
    const absCommon = path.isAbsolute(commonDir) ? commonDir : path.join(root, commonDir);
    // --absolute-git-dir resolves symlinks (e.g. macOS /tmp -> /private/tmp);
    // realpath both sides so a symlinked root doesn't look like a linked worktree.
    const [realGitDir, realCommon] = await Promise.all([
      fs.realpath(gitDir).catch(() => path.resolve(gitDir)),
      fs.realpath(absCommon).catch(() => path.resolve(absCommon)),
    ]);
    return realGitDir !== realCommon;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------- log

const LOG_FIELDS = '%H%x00%h%x00%P%x00%an%x00%ae%x00%at%x00%D%x00%s';

export async function log(root: string, { skip = 0, limit = 200, path: relPath = null }: LogOptions = {}): Promise<LogEntry[]> {
  const args = [
    'log',
    '--date-order',
    `--skip=${skip}`,
    `--max-count=${limit}`,
    `--pretty=format:${LOG_FIELDS}%x01`,
  ];
  if (relPath) args.push('--follow', '--', relPath);
  let out: string;
  try {
    out = await git(root, args);
  } catch {
    return []; // empty repository
  }
  return parseRecords(out).map(([hash, short, parents, author, email, time, refs, subject]) => ({
    hash: hash!,
    short: short!,
    parents: parents ? parents.split(' ') : [],
    author: author!,
    email: email!,
    time: Number(time) * 1000,
    refs: refs || '',
    subject: subject || '',
  }));
}

// Parses `--name-status -z` output (optionally prefixed by a commit id, as
// `diff-tree --root` does) into the shared CommitFile shape.
function parseNameStatus(out: string): CommitFile[] {
  const tokens = out.split('\0').filter(Boolean);
  const files: CommitFile[] = [];
  let i = 0;
  if (tokens[0] && /^[0-9a-f]{40}$/.test(tokens[0])) i = 1;
  for (; i < tokens.length; i++) {
    const st = tokens[i]![0];
    if (st === 'R' || st === 'C') {
      const origPath = tokens[++i]!;
      const p = tokens[++i]!;
      files.push({ path: p, origPath, type: 'MOVED' });
    } else {
      const p = tokens[++i]!;
      const type: ChangeType = st === 'A' ? 'ADDED' : st === 'D' ? 'DELETED' : 'MODIFIED';
      files.push({ path: p, origPath: null, type });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export async function commitDetails(root: string, hash: string): Promise<CommitDetails> {
  assertNotOption(hash, 'Commit');
  const meta = await git(root, [
    'show', '--no-patch', `--pretty=format:%H%x00%h%x00%P%x00%an%x00%ae%x00%at%x00%B`, hash,
  ]);
  const [full, short, parents, author, email, time, body] = meta.split('\0');
  const parentList = parents ? parents.split(' ').filter(Boolean) : [];
  // Changed files vs the first parent (or the empty tree for a root commit).
  const diffArgs = parentList.length
    ? ['diff-tree', '-r', '-z', '-M', '--name-status', `${hash}^`, hash]
    : ['diff-tree', '-r', '-z', '-M', '--name-status', '--root', hash];
  const out = await git(root, diffArgs);
  return {
    hash: full!,
    short: short!,
    parents: parentList,
    author: author!,
    email: email!,
    time: Number(time) * 1000,
    message: (body || '').trimEnd(),
    files: parseNameStatus(out),
  };
}

// Changed-file list between two arbitrary refs. `refB` falsy or 'WORKTREE'
// compares refA against the working tree (plain `git diff <ref>` already
// does this — no special-casing needed beyond omitting the second arg).
export async function compareRefs(root: string, refA: string, refB: string | null): Promise<CommitFile[]> {
  assertNotOption(refA, 'Ref');
  const args = ['diff', '--name-status', '-z', '-M', refA];
  if (refB && refB !== 'WORKTREE') {
    assertNotOption(refB, 'Ref');
    args.push(refB);
  }
  const out = await git(root, args);
  return parseNameStatus(out);
}

// Diff of one file between two arbitrary refs. `refB` of 'WORKTREE' compares
// against disk instead of a committed ref.
export async function refFileDiff(
  root: string,
  refA: string,
  refB: string,
  relPath: string,
  type: ChangeType,
  origPath: string | null
): Promise<DiffPayload> {
  assertNotOption(refA, 'Ref');
  if (refB !== 'WORKTREE') assertNotOption(refB, 'Ref');
  const abs = insideRepo(root, relPath);
  let origBuf: Buffer = Buffer.alloc(0);
  if (type !== 'ADDED') {
    origBuf = await showFileAt(root, refA, origPath || relPath);
  }
  let modBuf: Buffer = Buffer.alloc(0);
  if (type !== 'DELETED') {
    if (refB === 'WORKTREE') {
      try {
        modBuf = await fs.readFile(abs);
      } catch {
        modBuf = Buffer.alloc(0);
      }
    } else {
      modBuf = await showFileAt(root, refB, relPath);
    }
  }
  return classifyDiff(origBuf, modBuf, relPath);
}

// ------------------------------------------------------------------- stash

export async function stashList(root: string): Promise<StashEntry[]> {
  let out: string;
  try {
    out = await git(root, ['stash', 'list', '--pretty=format:%gd%x00%at%x00%gs%x01']);
  } catch {
    return [];
  }
  return parseRecords(out).map(([ref, time, message]) => ({
    ref: ref!,
    time: Number(time) * 1000,
    message: message || '',
  }));
}

export async function stashPush(root: string, message?: string | null, includeUntracked = true): Promise<string> {
  const args = ['stash', 'push'];
  if (includeUntracked) args.push('--include-untracked');
  if (message && message.trim()) args.push('-m', message.trim());
  return git(root, args);
}

export async function stashPop(root: string, ref: string): Promise<string> {
  return git(root, ['stash', 'pop', '--index', ref]);
}

export async function stashApply(root: string, ref: string): Promise<string> {
  return git(root, ['stash', 'apply', ref]);
}

export async function stashDrop(root: string, ref: string): Promise<string> {
  return git(root, ['stash', 'drop', ref]);
}

// ------------------------------------------------------------------- blame

const NULL_SHA = '0000000000000000000000000000000000000000';

export async function blame(root: string, relPath: string): Promise<BlameLine[]> {
  insideRepo(root, relPath);
  const out = await git(root, ['blame', '--line-porcelain', '--', relPath]);
  const meta = new Map<string, { author?: string; time?: number; summary?: string }>();
  const lines: BlameLine[] = [];
  let sha: string | null = null;
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (m) {
      sha = m[1]!;
      if (!meta.has(sha)) meta.set(sha, {});
      continue;
    }
    if (sha == null) continue;
    if (line.startsWith('\t')) {
      const info = meta.get(sha)!;
      lines.push({
        sha: sha.slice(0, 8),
        uncommitted: sha === NULL_SHA,
        author: sha === NULL_SHA ? 'Not committed' : info.author || '',
        time: info.time || 0,
        summary: info.summary || '',
      });
      continue;
    }
    const info = meta.get(sha)!;
    if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('author-time ')) info.time = Number(line.slice(12)) * 1000;
    else if (line.startsWith('summary ')) info.summary = line.slice(8);
  }
  return lines;
}

// --------------------------------------------------------------- conflicts

// Stage contents for an unmerged path: 1=base, 2=ours, 3=theirs.
export async function conflictInfo(root: string, relPath: string): Promise<ConflictInfoResult> {
  const abs = insideRepo(root, relPath);
  const stage = async (n: number): Promise<string | null> => {
    try {
      const buf = await gitRaw(root, ['show', `:${n}:${relPath}`]);
      return looksBinary(buf) ? null : buf.toString('utf8');
    } catch {
      return null;
    }
  };
  const [base, ours, theirs] = await Promise.all([stage(1), stage(2), stage(3)]);
  let worktree = '';
  try {
    worktree = await fs.readFile(abs, 'utf8');
  } catch {
    /* deleted in worktree */
  }
  // currentBranch already handles detached HEAD ("<sha> (detached)") and
  // matches what the status bar shows.
  const oursLabel = await currentBranch(root);
  let theirsLabel = 'Theirs';
  if (await mergeInProgress(root)) {
    try {
      const name = (await git(root, [
        'name-rev', '--name-only', '--exclude', 'tags/*', 'MERGE_HEAD',
      ])).trim();
      theirsLabel = name && name !== 'undefined' ? name : 'Theirs';
    } catch { /* keep default */ }
  } else {
    // Rebase / cherry-pick: name the incoming commit instead.
    try {
      theirsLabel = (await git(root, ['rev-parse', '--short', 'REBASE_HEAD'])).trim() || 'Theirs';
    } catch {
      try {
        theirsLabel =
          (await git(root, ['rev-parse', '--short', 'CHERRY_PICK_HEAD'])).trim() || 'Theirs';
      } catch { /* keep default */ }
    }
  }
  return { base, ours, theirs, worktree, oursLabel, theirsLabel };
}

export async function markResolved(root: string, relPath: string, content?: string | null): Promise<void> {
  insideRepo(root, relPath);
  if (typeof content === 'string') await saveFile(root, relPath, content);
  await git(root, ['add', '--', relPath]);
}

export async function push(root: string): Promise<string> {
  try {
    return await git(root, ['push']);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no upstream|set-upstream|does not match any/i.test(message)) {
      return git(root, ['push', '-u', 'origin', 'HEAD']);
    }
    throw err;
  }
}

export { git, insideRepo };
