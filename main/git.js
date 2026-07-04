'use strict';

const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');

const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_DIFF_BYTES = 5 * 1024 * 1024;

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr && stderr.trim()) || (stdout && stdout.trim()) || err.message;
        reject(new Error(msg));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function isRepo(dir) {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

async function repoRoot(dir) {
  return (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
}

async function hasHead(root) {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

async function currentBranch(root) {
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
function changeType(x, y) {
  if (x === '?' || y === '?') return 'UNVERSIONED';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'CONFLICT';
  if (x === 'R' || y === 'R') return 'MOVED';
  if (x === 'A' || y === 'A') return 'ADDED';
  if (x === 'D' || y === 'D') return 'DELETED';
  return 'MODIFIED';
}

// Parse `git status --porcelain=v1 -z` output. Rename entries are followed
// by the original path as a separate NUL-terminated token.
function parseStatusZ(out) {
  const tokens = out.split('\0').filter((t) => t.length > 0);
  const files = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const x = t[0];
    const y = t[1];
    const p = t.slice(3);
    const entry = { path: p, origPath: null, type: changeType(x, y), xy: (x + y).trim() };
    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') {
      entry.origPath = tokens[++i] || null;
    }
    files.push(entry);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function status(root) {
  const out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return {
    branch: await currentBranch(root),
    hasHead: await hasHead(root),
    files: parseStatusZ(out),
  };
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

async function headContent(root, relPath) {
  try {
    return await new Promise((resolve, reject) => {
      execFile(
        'git',
        ['show', `HEAD:${relPath}`],
        { cwd: root, maxBuffer: MAX_BUFFER, encoding: 'buffer' },
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      );
    });
  } catch {
    return Buffer.alloc(0);
  }
}

// HEAD version vs. working-tree version of one file (IntelliJ's default
// "compare with local" for the commit tool window).
async function fileDiff(root, relPath, type, origPath) {
  const abs = path.join(root, relPath);
  if (path.relative(root, abs).startsWith('..')) {
    throw new Error('Path escapes repository root');
  }

  let origBuf = Buffer.alloc(0);
  if (type !== 'ADDED' && type !== 'UNVERSIONED') {
    origBuf = await headContent(root, origPath || relPath);
  }

  let modBuf = Buffer.alloc(0);
  if (type !== 'DELETED') {
    try {
      modBuf = await fs.readFile(abs);
    } catch {
      modBuf = Buffer.alloc(0);
    }
  }

  if (looksBinary(origBuf) || looksBinary(modBuf)) {
    return { binary: true, original: '', modified: '', absPath: abs };
  }
  if (origBuf.length > MAX_DIFF_BYTES || modBuf.length > MAX_DIFF_BYTES) {
    return { tooLarge: true, binary: false, original: '', modified: '', absPath: abs };
  }
  return {
    binary: false,
    original: origBuf.toString('utf8'),
    modified: modBuf.toString('utf8'),
    absPath: abs,
  };
}

async function saveFile(root, relPath, content) {
  const abs = path.join(root, relPath);
  if (path.relative(root, abs).startsWith('..')) {
    throw new Error('Path escapes repository root');
  }
  await fs.writeFile(abs, content, 'utf8');
}

async function commit(root, files, message, amend) {
  if (!files.length) throw new Error('No files selected for commit');
  if (!message.trim() && !amend) throw new Error('Commit message is empty');
  await git(root, ['add', '-A', '--', ...files]);
  // Pathspec-limited commit: only the selected files are committed, even if
  // other changes happen to be staged (e.g. by git mv or a CLI `git add`).
  const args = ['commit'];
  if (amend) args.push('--amend');
  if (message.trim()) args.push('-m', message);
  else args.push('--no-edit');
  args.push('--', ...files);
  return git(root, args);
}

async function lastCommitMessage(root) {
  try {
    return (await git(root, ['log', '-1', '--pretty=%B'])).trimEnd();
  } catch {
    return '';
  }
}

// IntelliJ "Rollback": tracked files go back to HEAD, newly added files
// become unversioned again, unversioned files are deleted.
async function rollback(root, files) {
  const head = await hasHead(root);
  for (const f of files) {
    const abs = path.join(root, f.path);
    if (path.relative(root, abs).startsWith('..')) continue;
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

async function push(root) {
  try {
    return await git(root, ['push']);
  } catch (err) {
    if (/no upstream|set-upstream|does not match any/i.test(err.message)) {
      return git(root, ['push', '-u', 'origin', 'HEAD']);
    }
    throw err;
  }
}

module.exports = {
  git,
  isRepo,
  repoRoot,
  status,
  parseStatusZ,
  changeType,
  fileDiff,
  saveFile,
  commit,
  lastCommitMessage,
  rollback,
  push,
  hasHead,
  currentBranch,
};
