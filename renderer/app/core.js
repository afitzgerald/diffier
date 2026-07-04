'use strict';

/* Diffier renderer — IntelliJ-style commit tool window + diff viewer. */

/* global require, monaco */

// ------------------------------------------------------------------- state

const state = {
  repo: null,            // { root, name, isWorktree, recents }
  branch: '',
  track: null,           // { ahead, behind } vs upstream, or null
  files: [],             // [{ path, origPath, type }]
  checked: new Set(),    // paths checked for commit
  known: new Set(),      // paths ever seen (new files default to checked)
  collapsed: new Set(),  // collapsed directory keys
  rows: [],              // flattened visible rows for keyboard navigation
  selectedKey: null,     // key of selected row
  current: null,         // file currently open in the diff editor
  dirty: false,
  f7Armed: false,        // "press F7 again to go to next file"
  shiftF7Armed: false,
  settings: {},
  filter: '',            // tree filter text
  view: 'commit',        // left panel: 'commit' | 'log'
  hunks: new Map(),      // path -> { excluded:Set<hunkKey>, total, content }
  readOnlyDiff: null,    // { hash, short } when the editor shows a commit diff
  blameOn: false,
  imageDiff: null,       // current image payload when previewable
  conflict: null,        // active conflict-resolution session
  commitTemplate: '',
  log: {
    entries: [],
    skip: 0,
    done: false,
    loading: false,
    selected: null,      // hash
    details: null,
    filePath: null,      // file-history mode
  },
};

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
