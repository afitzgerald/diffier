'use strict';

/*
 * Pure data shapes for the git layer — deliberately zero imports and zero
 * Node-specific types (Buffer, NodeJS.*). main/git.ts re-exports these for
 * its own use; main/api-types.ts (and, through it, renderer/global.d.ts)
 * import ONLY from this file, not from git.ts directly.
 *
 * Why this file exists at all: TypeScript type-checks an entire source file
 * once anything is imported from it, even a single `import type`. git.ts's
 * implementation uses Buffer/NodeJS.ProcessEnv, which don't exist under the
 * renderer program's browser lib config — importing from git.ts there would
 * fail on unrelated code the renderer never touches. Splitting the plain
 * data types out keeps them shareable without dragging in the Node runtime.
 */

export type ChangeType = 'MODIFIED' | 'ADDED' | 'DELETED' | 'UNVERSIONED' | 'CONFLICT' | 'MOVED';

export interface FileEntry {
  path: string;
  origPath: string | null;
  type: ChangeType;
  xy: string;
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

export interface StatusResult {
  branch: string;
  hasHead: boolean;
  files: FileEntry[];
  track: AheadBehind | null;
  merging: boolean;
}

// Shape shared by fileDiff (HEAD vs worktree) and commitFileDiff (parent vs
// commit). Field presence varies by case: binary files carry no text, an
// oversized diff carries neither text nor image data, and only images (plus
// SVGs, which are also valid text) carry the image fields.
export interface DiffPayload {
  binary: boolean;
  tooLarge?: boolean;
  original: string;
  modified: string;
  image?: boolean;
  imageMime?: string | null;
  originalImage?: string | null;
  modifiedImage?: string | null;
}

export interface FileDiffResult extends DiffPayload {
  absPath: string;
}

export interface ImageDataResult {
  imageMime: string;
  originalImage: string | null;
  modifiedImage: string | null;
}

export interface BranchEntry {
  name: string;
  current: boolean;
  upstream: string | null;
  track: string;
  sha: string;
}

export interface BranchesResult {
  current: string;
  locals: BranchEntry[];
  remotes: string[];
}

export interface LogOptions {
  skip?: number;
  limit?: number;
  path?: string | null;
}

export interface LogEntry {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  refs: string;
  subject: string;
}

export interface CommitFile {
  path: string;
  origPath: string | null;
  type: ChangeType;
}

export interface CommitDetails {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  message: string;
  files: CommitFile[];
}

export interface StashEntry {
  ref: string;
  time: number;
  message: string;
}

export interface BlameLine {
  sha: string;
  uncommitted: boolean;
  author: string;
  time: number;
  summary: string;
}

export interface ConflictInfoResult {
  base: string | null;
  ours: string | null;
  theirs: string | null;
  worktree: string;
  oursLabel: string;
  theirsLabel: string;
}

// A file contributing only some of its hunks to a commit. `content` is the
// exact text to record (HEAD content plus the checked hunks); `expected*`
// are snapshots the renderer prepared the selection against, verified here
// before the commit is recorded.
export interface PartialCommitFile {
  path: string;
  content: string;
  expectedWorktree?: string;
  expectedHead?: string;
}
