'use strict';
const state = {
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
    log: {
        entries: [],
        graphLanes: [],
        done: false,
        loading: false,
        selected: null,
        filePath: null,
    },
};
// The diff pane's mutually exclusive modes. Everything that behaves
// differently per mode should branch on this, not re-derive it.
function paneMode() {
    if (state.conflict)
        return 'conflict';
    if (state.readOnlyDiff)
        return 'commit';
    if (state.current)
        return 'worktree';
    return 'empty';
}
let diffEditor = null;
let originalModel = null;
let modifiedModel = null;
let currentModelsPath = null; // worktree path the diff models were built from
let suppressModelEvents = false;
let conflictEditor = null;
let conflictModel = null;
function $(id) {
    return document.getElementById(id);
}
const treeEl = $('tree');
// ------------------------------------------------------------------- toast
let toastTimer;
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
// A caught value in a catch block is `unknown`; every call site does the
// same "does this look like an Error" extraction.
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
