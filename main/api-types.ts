'use strict';

/*
 * Shapes shared across the process boundary: main.ts's IPC handlers,
 * preload.ts's contextBridge surface, and (via renderer/global.d.ts) the
 * renderer's `window.api`. Keeping them here means a signature change is a
 * type error everywhere it matters, not just a runtime surprise.
 */

import type {
  BlameLine,
  BranchesResult,
  ChangeType,
  CommitDetails,
  CommitFile,
  ConflictInfoResult,
  DiffPayload,
  FileDiffResult,
  FileEntry,
  ImageDataResult,
  LogEntry,
  LogOptions,
  PartialCommitFile,
  StashEntry,
  StatusResult,
} from './git-types';
import type { ActionId, Binding, KeymapAction, KeymapOverrides } from './keymap-types';
import type { Theme, ThemeId } from './themes';

export interface RepoInfo {
  root: string;
  name: string;
  isWorktree: boolean;
  recents: string[];
}

// Persisted to settings.json (userData) via settings:get/settings:set. All
// fields are optional — a fresh install starts from `{}`.
export interface Settings {
  lastRepo?: string;
  recentRepos?: string[];
  theme?: ThemeId;
  keymap?: KeymapOverrides;
  viewMode?: 'side' | 'unified';
  ignoreWhitespace?: boolean;
  collapseUnchanged?: boolean;
  panelWidth?: number;
  panelSide?: 'left' | 'right';
  commitHistory?: string[];
}

export interface AppInfo {
  name: string;
  version: string;
}

export interface ConfirmOptions {
  message: string;
  detail?: string;
  confirmLabel?: string;
}

export interface CommitOptions {
  files: string[];
  message: string;
  amend: boolean;
  partials?: PartialCommitFile[];
}

// The renderer's rollback IPC only needs enough of FileEntry to decide what
// to revert; kept structurally compatible with the real FileEntry.
export type RollbackTarget = Pick<FileEntry, 'path' | 'type' | 'origPath'>;

export type { ConflictInfoResult };

// The full window.api surface exposed by preload.ts via contextBridge.
export interface DiffierApi {
  openRepoDialog(): Promise<RepoInfo | null>;
  // Null means the repo is already open in another window, which has been
  // focused instead — the caller should leave its own view untouched.
  openRepo(dir: string): Promise<RepoInfo | null>;
  openLastRepo(): Promise<RepoInfo | null>;

  gitStatus(): Promise<StatusResult>;
  gitDiff(relPath: string, type: ChangeType, origPath: string | null): Promise<FileDiffResult>;
  gitCommit(opts: CommitOptions): Promise<string>;
  gitPush(): Promise<string>;
  gitPull(): Promise<string>;
  gitFetch(): Promise<string>;
  gitBranches(): Promise<BranchesResult>;
  gitCheckout(name: string): Promise<string>;
  gitCreateBranch(name: string): Promise<string>;
  gitLog(opts: LogOptions): Promise<LogEntry[]>;
  gitCommitDetails(hash: string): Promise<CommitDetails>;
  gitCompareRefs(refA: string, refB: string | null): Promise<CommitFile[]>;
  gitRefFileDiff(
    refA: string,
    refB: string,
    relPath: string,
    type: ChangeType,
    origPath: string | null
  ): Promise<DiffPayload>;
  gitImageData(
    relPath: string,
    type: ChangeType,
    origPath: string | null,
    leftRef?: string | null,
    rightRef?: string | null
  ): Promise<ImageDataResult>;
  gitStashList(): Promise<StashEntry[]>;
  gitStashPush(message?: string | null, includeUntracked?: boolean): Promise<string>;
  gitStashPop(ref: string): Promise<string>;
  gitStashApply(ref: string): Promise<string>;
  gitStashDrop(ref: string): Promise<string>;
  gitBlame(relPath: string): Promise<BlameLine[]>;
  gitConflictInfo(relPath: string): Promise<ConflictInfoResult>;
  gitMarkResolved(relPath: string, content?: string | null): Promise<void>;
  gitCommitTemplate(): Promise<string>;
  gitRollback(files: RollbackTarget[]): Promise<void>;
  gitLastMessage(): Promise<string>;
  setBadge(count: number): Promise<void>;
  getAppInfo(): Promise<AppInfo>;

  saveFile(relPath: string, content: string): Promise<void>;
  revealFile(relPath: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  confirm(opts: ConfirmOptions): Promise<boolean>;

  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;

  keymapActions: KeymapAction[];
  setKeymap(overrides: KeymapOverrides): Promise<void>;

  themes: Record<ThemeId, Theme>;
  defaultTheme: ThemeId;

  onMenu(cb: (id: string) => void): void;
  onRepoChanged(cb: () => void): void;
  onRepoOpened(cb: (repo: RepoInfo) => void): void;
}

export type { ActionId, Binding };
