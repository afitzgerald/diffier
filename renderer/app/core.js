'use strict';

/* Diffier renderer — IntelliJ-style commit tool window + diff viewer. */

/* global require, monaco */

// ------------------------------------------------------------------- state

const state = {
  repo: null,            // { root, name, isWorktree, recents }
  merging: false,        // a merge is in progress (MERGE_HEAD exists)
  files: [],             // [{ path, origPath, type }]
  checked: new Set(),    // paths checked for commit
  known: new Set(),      // paths ever seen (new files default to checked)
  collapsed: new Set(),  // collapsed directory keys
  rows: [],              // flattened visible rows for keyboard navigation
  selectedKey: null,     // key of selected row
  // Diff pane mode — exactly one of these is set; use paneMode() to branch:
  current: null,         //   editable worktree diff: the open file
  readOnlyDiff: null,    //   commit diff from the Log tab: { hash, path }
  conflict: null,        //   conflict-resolution session
  dirty: false,
  f7Armed: false,        // "press F7 again to go to next file"
  shiftF7Armed: false,
  settings: {},
  filter: '',            // tree filter text
  view: 'commit',        // left panel: 'commit' | 'log'
  hunks: new Map(),      // path -> { excluded:Set<hunkKey>, total, content, snapshots }
  blameOn: false,
  imageDiff: null,       // { file, hash, payload } when a preview is available
  commitTemplate: '',
  log: {
    entries: [],
    graphLanes: [],      // running lane state for incremental graph layout
    done: false,
    loading: false,
    selected: null,      // hash
    filePath: null,      // file-history mode
  },
};

// The diff pane's mutually exclusive modes. Everything that behaves
// differently per mode should branch on this, not re-derive it.
function paneMode() {
  if (state.conflict) return 'conflict';
  if (state.readOnlyDiff) return 'commit';
  if (state.current) return 'worktree';
  return 'empty';
}

let diffEditor = null;
let originalModel = null;
let modifiedModel = null;
let currentModelsPath = null; // worktree path the diff models were built from
let suppressModelEvents = false;
let conflictEditor = null;
let conflictModel = null;

const $ = (id) => document.getElementById(id);
const treeEl = $('tree');

// ------------------------------------------------------------------- toast

let toastTimer = null;
function toast(msg, isError) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 5000 : 2600);
}

function statusMsg(msg) {
  $('status-message').textContent = msg;
}
