'use strict';

/* Diffier renderer — IntelliJ-style commit tool window + diff viewer. */

// ------------------------------------------------------------------- state

type PaneMode = 'conflict' | 'commit' | 'worktree' | 'empty';

// Generic over the file-entry shape so the same tree model/renderer serves
// both the worktree changes list (FileEntry) and a commit's file list
// (CommitFile, which lacks FileEntry's worktree-only `xy` field).
interface TreeNode<T extends { path: string } = FileEntry> {
  name: string;
  dirs: Map<string, TreeNode<T>>;
  files: T[];
}

interface TreeFileRow<T extends { path: string } = FileEntry> {
  kind: 'file';
  key: string;
  file: T;
  depth: number;
}

interface TreeDirRow<T extends { path: string } = FileEntry> {
  kind: 'dir';
  key: string;
  node: TreeNode<T>;
  depth: number;
}

type TreeRow<T extends { path: string } = FileEntry> = TreeFileRow<T> | TreeDirRow<T>;

// path -> per-file partial-staging bookkeeping (staging.ts owns the logic).
interface HunkEntry {
  excluded: Set<string>;
  total: number;
  content: string;
  snapshotModified?: string;
  snapshotOriginal?: string;
  rebuildTimer?: ReturnType<typeof setTimeout>;
}

// The diff pane displays either a worktree FileEntry or a commit's
// CommitFile; both are structurally this shape wherever only path/type
// matter (setDiffHeader, presentDiff, the image-preview descriptor).
type DiffableFile = Pick<FileEntry, 'path' | 'origPath' | 'type'>;

// showImageDiff() only ever reads these three fields; a populated DiffPayload
// (the SVG case, from presentDiff) and an ImageDataResult (the on-demand
// fetch in boot.ts) both satisfy this without a cast.
type ImagePayloadLike = Pick<ImageDataResult, 'imageMime' | 'originalImage' | 'modifiedImage'>;

interface ImageDiffDescriptor {
  file: DiffableFile;
  leftRef: string | null;
  rightRef: string | null;
  payload: ImagePayloadLike | null;
}

interface ConflictRegion {
  start: number;
  base: number;
  sep: number;
  end: number;
}

interface ConflictSession {
  path: string;
  info: ConflictInfoResult;
  regions: ConflictRegion[];
}

// Lane-graph layout for one commit row (log.ts's computeLogGraph).
interface LogGraphInfo {
  col: number;
  before: (string | null)[];
  after: (string | null)[];
  merging: number[];
  forks: number[];
}

interface LogEntryWithGraph extends LogEntry {
  graph?: LogGraphInfo;
}

interface LogState {
  entries: LogEntryWithGraph[];
  graphLanes: (string | null)[];
  done: boolean;
  loading: boolean;
  selected: string | null;
  filePath: string | null;
  details: CommitDetails | null; // currently shown commit, for next/prev-file nav
  collapsed: Set<string>; // collapsed directory keys in the commit file tree
  rows: TreeRow<CommitFile>[]; // flattened visible rows of the commit file tree
  gen?: number;
  marked: Set<string>; // ctrl/cmd-clicked hashes, capped at 2, for "Compare Selected Commits"
}

interface CompareState {
  refA: string;
  refB: string; // '' means "working tree"
  files: CommitFile[];
  collapsed: Set<string>; // collapsed directory keys in the compare file tree
  rows: TreeRow<CommitFile>[]; // flattened visible rows of the compare file tree
  gen: number; // bumped on each runCompare(); discards superseded in-flight results
}

interface AppState {
  repo: RepoInfo | null;
  merging: boolean; // a merge is in progress (MERGE_HEAD exists)
  files: FileEntry[];
  checked: Set<string>; // paths checked for commit
  known: Set<string>; // paths ever seen (new files default to checked)
  collapsed: Set<string>; // collapsed directory keys
  rows: TreeRow[]; // flattened visible rows for keyboard navigation
  selectedKey: string | null; // key of selected row
  // Diff pane mode — exactly one of these is set; use paneMode() to branch:
  current: FileEntry | null; //   editable worktree diff: the open file
  readOnlyDiff: { leftRef: string; rightRef: string; path: string } | null; //   commit/compare diff (Log or Compare tab)
  conflict: ConflictSession | null; //   conflict-resolution session
  dirty: boolean;
  f7Armed: boolean; // "press F7 again to go to next file"
  shiftF7Armed: boolean;
  settings: Settings;
  filter: string; // tree filter text
  view: 'commit' | 'log' | 'compare'; // left panel
  hunks: Map<string, HunkEntry>;
  blameOn: boolean;
  imageDiff: ImageDiffDescriptor | null;
  commitTemplate: string;
  log: LogState;
  compare: CompareState;
  zoomLevel: number; // temporary font-size offset (px) for diff/conflict editors + markdown; resets on restart
}

const state: AppState = {
  repo: null,
  merging: false,
  files: [],
  checked: new Set(),
  known: new Set(),
  collapsed: new Set(),
  rows: [],
  selectedKey: null,
  current: null,
  readOnlyDiff: null,
  conflict: null,
  dirty: false,
  f7Armed: false,
  shiftF7Armed: false,
  settings: {},
  filter: '',
  view: 'commit',
  hunks: new Map(),
  blameOn: false,
  imageDiff: null,
  commitTemplate: '',
  zoomLevel: 0,
  log: {
    entries: [],
    graphLanes: [],
    done: false,
    loading: false,
    selected: null,
    filePath: null,
    details: null,
    collapsed: new Set(),
    rows: [],
    marked: new Set(),
  },
  compare: {
    refA: '',
    refB: '',
    files: [],
    collapsed: new Set(),
    rows: [],
    gen: 0,
  },
};

// The diff pane's mutually exclusive modes. Everything that behaves
// differently per mode should branch on this, not re-derive it.
function paneMode(): PaneMode {
  if (state.conflict) return 'conflict';
  if (state.readOnlyDiff) return 'commit';
  if (state.current) return 'worktree';
  return 'empty';
}

let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
let originalModel: monaco.editor.ITextModel | null = null;
let modifiedModel: monaco.editor.ITextModel | null = null;
let currentModelsPath: string | null = null; // worktree path the diff models were built from
let suppressModelEvents = false;
let conflictEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let conflictModel: monaco.editor.ITextModel | null = null;

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
const treeEl = $('tree');

// ------------------------------------------------------------------- toast

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string, isError?: boolean): void {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 5000 : 2600);
}

function statusMsg(msg: string): void {
  $('status-message').textContent = msg;
}

// A caught value in a catch block is `unknown`; every call site does the
// same "does this look like an Error" extraction.
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
