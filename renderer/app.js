'use strict';

/* Diffier renderer — IntelliJ-style commit tool window + diff viewer. */

/* global require, monaco */

// ------------------------------------------------------------------- state

const state = {
  repo: null,            // { root, name }
  branch: '',
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
};

let diffEditor = null;
let originalModel = null;
let modifiedModel = null;
let suppressModelEvents = false;

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

// ------------------------------------------------------------------ themes

const THEMES = window.api.themes || {};
const DEFAULT_THEME = window.api.defaultTheme || 'islands-dark';

function currentTheme() {
  const id = state.settings.theme;
  return THEMES[id] || THEMES[DEFAULT_THEME];
}

function applyTheme(id) {
  const t = THEMES[id] || THEMES[DEFAULT_THEME];
  if (!t) return;
  for (const [k, v] of Object.entries(t.vars)) {
    document.documentElement.style.setProperty('--' + k, v);
  }
  document.body.dataset.theme = t.id;
  document.body.dataset.themeStyle = t.style;
  state.settings.theme = t.id;
  if (window.monaco && monaco.editor) {
    monaco.editor.defineTheme('diffier-theme', t.monaco);
    monaco.editor.setTheme('diffier-theme');
  }
  const sel = $('theme-select');
  if (sel && sel.value !== t.id) sel.value = t.id;
}

async function setTheme(id) {
  applyTheme(id);
  try {
    await window.api.setSettings({ theme: state.settings.theme });
  } catch {
    /* theme still applied locally */
  }
}

// ------------------------------------------------------------------ keymap

const IS_MAC = /Mac/i.test(navigator.platform);
const KEYMAP_ACTIONS = window.api.keymapActions || [];
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];

const km = {
  overrides: {},            // actionId -> binding string | null (unbound)
  bindings: new Map(),      // actionId -> normalized binding | null
  byBinding: new Map(),     // normalized binding -> actionId
  recordingAction: null,    // actionId while capturing a new shortcut
  dialogOpen: false,
};

function kmDefault(id) {
  const a = KEYMAP_ACTIONS.find((x) => x.id === id);
  return a ? a.default : null;
}

function kmRaw(id) {
  return Object.prototype.hasOwnProperty.call(km.overrides, id)
    ? km.overrides[id]
    : kmDefault(id);
}

// Same normalization as main/keymap.js: Mod resolved per platform, modifiers
// in canonical order, single letters uppercased.
function normalizeBinding(binding) {
  if (!binding) return null;
  const parts = binding.split('+');
  let key = parts.pop();
  if (key.length === 1) key = key.toUpperCase();
  const mods = new Set(parts.map((m) => (m === 'Mod' ? (IS_MAC ? 'Meta' : 'Ctrl') : m)));
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

function rebuildKeymap() {
  km.bindings.clear();
  km.byBinding.clear();
  for (const a of KEYMAP_ACTIONS) {
    const norm = normalizeBinding(kmRaw(a.id));
    km.bindings.set(a.id, norm);
    if (norm) km.byBinding.set(norm, a.id);
  }
  updateShortcutHints();
}

function prettyBinding(norm) {
  if (!norm) return 'None';
  const SYM = IS_MAC
    ? { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }
    : { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Super' };
  const KEY = {
    Escape: 'Esc', Enter: IS_MAC ? '⏎' : 'Enter', Space: 'Space',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  };
  const parts = norm.split('+');
  const key = parts.pop();
  const mods = parts.map((m) => SYM[m]);
  const shown = KEY[key] || key;
  return IS_MAC ? mods.join('') + shown : [...mods, shown].join('+');
}

function actionShortcut(id) {
  return prettyBinding(km.bindings.get(id));
}

function updateShortcutHints() {
  const hint = (id) => {
    const s = actionShortcut(id);
    return s === 'None' ? '' : ` (${s})`;
  };
  $('btn-next-diff').title = 'Next Difference' + hint('next-diff');
  $('btn-prev-diff').title = 'Previous Difference' + hint('prev-diff');
  $('btn-next-file').title = 'Next Changed File' + hint('next-file');
  $('btn-prev-file').title = 'Previous Changed File' + hint('prev-file');
  $('btn-commit').title = 'Commit' + hint('commit-execute');
  $('btn-commit-push').title = 'Commit and Push' + hint('commit-and-push');
  $('btn-refresh').title = 'Refresh File Status' + hint('refresh');
  $('btn-rollback').title = 'Rollback…' + hint('rollback');
  $('btn-keymap').title = 'Settings' + hint('keymap-settings');
}

// Layout-stable key name from a keyboard event (e.key for shifted
// punctuation varies — ⌘⇧] reports key '}' — so punctuation and letters come
// from e.code, matching how Electron accelerators are interpreted).
const CODE_KEYS = {
  BracketRight: ']', BracketLeft: '[', Comma: ',', Period: '.', Slash: '/',
  Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`', Minus: '-',
  Equal: '=', Enter: 'Enter', NumpadEnter: 'Enter', Space: 'Space',
  Escape: 'Escape',
};

function eventToBinding(e) {
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return null;
  let key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  else if (/^F\d+$/.test(e.key)) key = e.key;
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  return [...mods, key].join('+');
}

function inEditableContext() {
  const el = document.activeElement;
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
}

// While typing, only chords with a real modifier — or F-keys / Escape — may
// trigger actions; bare printable keys are text input.
function bindingAllowedHere(norm) {
  if (!inEditableContext()) return true;
  const parts = norm.split('+');
  const key = parts.pop();
  if (parts.some((m) => m !== 'Shift')) return true;
  return /^F\d+$/.test(key) || key === 'Escape';
}

async function saveKeymap() {
  rebuildKeymap();
  try {
    await window.api.setKeymap(km.overrides); // persists + rebuilds app menu
  } catch (err) {
    toast('Failed to save keymap: ' + err.message, true);
  }
}

// ------------------------------------------------------------------ monaco

const monacoReady = new Promise((resolve) => {
  require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
  // Workers can't be created cross-origin from file:// — monaco falls back to
  // computing diffs on the main thread, which is fine at our file sizes.
  window.MonacoEnvironment = {
    getWorker: () => {
      throw new Error('workers disabled; monaco falls back to main thread');
    },
  };
  require(['vs/editor/editor.main'], () => {
    // Monaco binds F7/Shift+F7 to its accessible diff viewer; difference
    // navigation is ours (and rebindable), so drop Monaco's claim on them.
    try {
      monaco.editor.addKeybindingRules([
        { keybinding: monaco.KeyCode.F7, command: null },
        { keybinding: monaco.KeyMod.Shift | monaco.KeyCode.F7, command: null },
      ]);
    } catch {
      /* older monaco without addKeybindingRules */
    }
    monaco.editor.defineTheme('diffier-theme', currentTheme().monaco);

    diffEditor = monaco.editor.createDiffEditor($('diff-editor'), {
      theme: 'diffier-theme',
      automaticLayout: true,
      renderSideBySide: state.settings.viewMode !== 'unified',
      originalEditable: false,
      readOnly: true,
      ignoreTrimWhitespace: !!state.settings.ignoreWhitespace,
      renderMarginRevertIcon: true,
      fontFamily: 'SF Mono, Menlo, Monaco, JetBrains Mono, Consolas, monospace',
      fontSize: 12,
      lineHeight: 19,
      scrollBeyondLastLine: false,
      renderOverviewRuler: true,
      diffWordWrap: 'off',
      minimap: { enabled: false },
      padding: { top: 4 },
    });

    diffEditor.onDidUpdateDiff(() => updateDiffCount());

    // Any keypress other than the next/prev-difference bindings (or a bare
    // modifier, e.g. the Shift in Shift+F7) disarms the "go to next file"
    // prompt.
    diffEditor.getModifiedEditor().onKeyDown((e) => {
      const b = eventToBinding(e.browserEvent);
      if (!b) return; // bare modifier
      if (b !== km.bindings.get('next-diff') && b !== km.bindings.get('prev-diff')) {
        state.f7Armed = false;
        state.shiftF7Armed = false;
      }
    });

    resolve();
  });
});

function getLineChanges() {
  return (diffEditor && diffEditor.getLineChanges()) || [];
}

function updateDiffCount() {
  const el = $('diff-count');
  if (!state.current) {
    el.textContent = '';
    return;
  }
  const n = getLineChanges().length;
  el.textContent = n === 0 ? 'Contents are identical' : `${n} difference${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------- language

function languageFor(filePath) {
  const ext = ('.' + filePath.split('.').pop()).toLowerCase();
  const langs = monaco.languages.getLanguages();
  for (const l of langs) {
    if (l.extensions && l.extensions.includes(ext)) return l.id;
  }
  const base = filePath.split('/').pop().toLowerCase();
  for (const l of langs) {
    if (l.filenames && l.filenames.includes(base)) return l.id;
  }
  return 'plaintext';
}

// ------------------------------------------------------------- tree model

// Build an IntelliJ-style tree: directories first, single-child directory
// chains compressed into one node ("src/main/java").
function buildTree(files) {
  const root = { name: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!node.dirs.has(seg)) node.dirs.set(seg, { name: seg, dirs: new Map(), files: [] });
      node = node.dirs.get(seg);
    }
    node.files.push(f);
  }

  function compress(node) {
    for (const [key, child] of [...node.dirs]) {
      let c = child;
      while (c.dirs.size === 1 && c.files.length === 0) {
        const [[gkey, gchild]] = [...c.dirs];
        c = { name: c.name + '/' + gchild.name, dirs: gchild.dirs, files: gchild.files };
        void gkey;
      }
      node.dirs.set(key, c);
      compress(c);
    }
  }
  compress(root);
  return root;
}

function countFiles(node) {
  let n = node.files.length;
  for (const child of node.dirs.values()) n += countFiles(child);
  return n;
}

function collectFiles(node, out = []) {
  for (const child of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    collectFiles(child, out);
  }
  for (const f of node.files) out.push(f);
  return out;
}

function flattenRows(node, depth, prefix, out) {
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const d of dirs) {
    const key = 'dir:' + prefix + d.name;
    out.push({ kind: 'dir', key, node: d, depth });
    if (!state.collapsed.has(key)) {
      flattenRows(d, depth + 1, prefix + d.name + '/', out);
    }
  }
  for (const f of node.files.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    out.push({ kind: 'file', key: 'file:' + f.path, file: f, depth });
  }
}

const TYPE_ICON = {
  MODIFIED: '●',
  ADDED: '＋',
  DELETED: '－',
  UNVERSIONED: '？',
  CONFLICT: '⚠',
  MOVED: '➜',
};

function renderTree() {
  const tree = buildTree(state.files);
  const rows = [];
  flattenRows(tree, 0, '', rows);
  state.rows = rows;

  treeEl.textContent = '';

  if (!state.files.length) {
    const div = document.createElement('div');
    div.className = 'empty-msg';
    div.textContent = state.repo ? 'No changes' : 'No repository open';
    treeEl.appendChild(div);
    updateCommitCount();
    return;
  }

  // Synthetic "Changes" root, like IntelliJ's changelist node.
  const rootRow = document.createElement('div');
  rootRow.className = 'tree-row';
  rootRow.style.paddingLeft = '6px';
  rootRow.innerHTML =
    `<span class="tree-chevron">▾</span>` +
    `<span class="dir-name">Changes</span>` +
    `<span class="dir-count">${state.files.length} file${state.files.length === 1 ? '' : 's'}</span>`;
  treeEl.appendChild(rootRow);

  for (const row of rows) {
    const el = document.createElement('div');
    el.className = 'tree-row';
    el.dataset.key = row.key;
    el.style.paddingLeft = 6 + (row.depth + 1) * 14 + 'px';
    if (row.key === state.selectedKey) el.classList.add('selected');

    if (row.kind === 'dir') {
      const chev = document.createElement('span');
      chev.className = 'tree-chevron';
      chev.textContent = state.collapsed.has(row.key) ? '▸' : '▾';
      el.appendChild(chev);

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      const all = collectFiles(row.node);
      const checkedCount = all.filter((f) => state.checked.has(f.path)).length;
      cb.checked = checkedCount === all.length && all.length > 0;
      cb.indeterminate = checkedCount > 0 && checkedCount < all.length;
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = checkedCount !== all.length;
        for (const f of all) {
          if (target) state.checked.add(f.path);
          else state.checked.delete(f.path);
        }
        renderTree();
      });
      el.appendChild(cb);

      const name = document.createElement('span');
      name.className = 'dir-name file-name';
      name.textContent = row.node.name;
      el.appendChild(name);

      const count = document.createElement('span');
      count.className = 'dir-count';
      count.textContent = String(countFiles(row.node));
      el.appendChild(count);

      el.addEventListener('click', () => {
        selectRow(row.key);
        toggleCollapse(row.key);
      });
    } else {
      const chev = document.createElement('span');
      chev.className = 'tree-chevron';
      el.appendChild(chev);

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.checked.has(row.file.path);
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleChecked(row.file.path);
      });
      el.appendChild(cb);

      const icon = document.createElement('span');
      icon.className = 'tree-icon file-name ' + row.file.type;
      icon.textContent = TYPE_ICON[row.file.type] || '●';
      el.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'file-name ' + row.file.type;
      name.textContent = row.file.path.split('/').pop();
      name.title = row.file.origPath
        ? `${row.file.origPath} → ${row.file.path}`
        : row.file.path;
      el.appendChild(name);

      el.addEventListener('click', () => selectRow(row.key));
      el.addEventListener('dblclick', () => {
        selectRow(row.key);
        focusEditor();
      });
    }
    treeEl.appendChild(el);
  }
  updateCommitCount();
}

function toggleCollapse(key) {
  if (state.collapsed.has(key)) state.collapsed.delete(key);
  else state.collapsed.add(key);
  renderTree();
}

function toggleChecked(path) {
  if (state.checked.has(path)) state.checked.delete(path);
  else state.checked.add(path);
  renderTree();
}

function updateCommitCount() {
  const n = state.checked.size;
  $('commit-count').textContent = state.files.length
    ? `${n} of ${state.files.length} selected`
    : '';
  $('btn-commit').disabled = n === 0;
  $('btn-commit-push').disabled = n === 0;
}

// ---------------------------------------------------------- row selection

function fileRows() {
  return state.rows.filter((r) => r.kind === 'file');
}

function selectedRow() {
  return state.rows.find((r) => r.key === state.selectedKey) || null;
}

function selectRow(key, revealEnd) {
  state.selectedKey = key;
  for (const el of treeEl.querySelectorAll('.tree-row')) {
    el.classList.toggle('selected', el.dataset.key === key);
  }
  const el = treeEl.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
  const row = state.rows.find((r) => r.key === key);
  if (row && row.kind === 'file') openDiff(row.file, revealEnd);
}

function moveSelection(delta) {
  if (!state.rows.length) return;
  const idx = state.rows.findIndex((r) => r.key === state.selectedKey);
  const next = Math.min(state.rows.length - 1, Math.max(0, idx + delta));
  selectRow(state.rows[next].key);
}

function selectFileByOffset(delta, revealEnd) {
  const rows = fileRows();
  if (!rows.length) return false;
  let idx = rows.findIndex(
    (r) => state.current && r.file.path === state.current.path
  );
  if (idx === -1) idx = delta > 0 ? -1 : 0;
  const next = idx + delta;
  if (next < 0 || next >= rows.length) return false;
  selectRow(rows[next].key, revealEnd);
  return true;
}

// ------------------------------------------------------------- diff editor

async function openDiff(file, revealEnd) {
  await monacoReady;
  await autosaveIfDirty();

  state.current = file;
  state.f7Armed = false;
  state.shiftF7Armed = false;

  $('diff-file-path').textContent = file.origPath
    ? `${file.origPath} → ${file.path}`
    : file.path;
  $('diff-file-path').classList.remove('dim');
  const icon = $('diff-file-icon');
  icon.className = 'file-name ' + file.type;
  icon.textContent = TYPE_ICON[file.type] || '●';
  $('diff-empty').classList.add('hidden');

  let diff;
  try {
    diff = await window.api.gitDiff(file.path, file.type, file.origPath);
  } catch (err) {
    toast('Failed to load diff: ' + err.message, true);
    return;
  }
  if (state.current !== file) return; // user moved on while we loaded

  disposeModels();

  if (diff.binary || diff.tooLarge) {
    const note = diff.binary ? 'Binary file — cannot show diff' : 'File is too large to diff';
    originalModel = monaco.editor.createModel('', 'plaintext');
    modifiedModel = monaco.editor.createModel(note, 'plaintext');
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    diffEditor.updateOptions({ readOnly: true });
    setDirty(false);
    updateDiffCount();
    return;
  }

  const lang = languageFor(file.path);
  originalModel = monaco.editor.createModel(diff.original, lang);
  modifiedModel = monaco.editor.createModel(diff.modified, lang);
  diffEditor.setModel({ original: originalModel, modified: modifiedModel });

  const editable = file.type !== 'DELETED';
  diffEditor.updateOptions({ readOnly: !editable });
  setDirty(false);

  modifiedModel.onDidChangeContent(() => {
    if (!suppressModelEvents) setDirty(true);
  });

  // Position on the first change once the diff has been computed.
  const once = diffEditor.onDidUpdateDiff(() => {
    once.dispose();
    const changes = getLineChanges();
    if (changes.length) {
      const target = revealEnd ? changes[changes.length - 1] : changes[0];
      gotoChange(target);
    }
    updateDiffCount();
  });
}

function disposeModels() {
  suppressModelEvents = true;
  if (diffEditor) diffEditor.setModel(null);
  if (originalModel) originalModel.dispose();
  if (modifiedModel) modifiedModel.dispose();
  originalModel = modifiedModel = null;
  suppressModelEvents = false;
}

function setDirty(d) {
  state.dirty = d;
  $('diff-dirty').textContent = d ? '*' : '';
}

async function autosaveIfDirty() {
  if (!state.dirty || !state.current || !modifiedModel) return;
  try {
    await window.api.saveFile(state.current.path, modifiedModel.getValue());
    setDirty(false);
  } catch (err) {
    toast('Autosave failed: ' + err.message, true);
  }
}

async function saveCurrent() {
  if (!state.current || !modifiedModel) return;
  try {
    await window.api.saveFile(state.current.path, modifiedModel.getValue());
    setDirty(false);
    statusMsg('Saved ' + state.current.path);
    await refreshStatus(true);
  } catch (err) {
    toast('Save failed: ' + err.message, true);
  }
}

function focusEditor() {
  if (diffEditor && state.current) diffEditor.getModifiedEditor().focus();
}

// -------------------------------------------------------- diff navigation

function changeStartLine(c) {
  // For pure deletions modifiedStartLineNumber can be 0.
  return Math.max(1, c.modifiedEndLineNumber > 0 ? c.modifiedStartLineNumber : c.modifiedStartLineNumber + 1);
}

function gotoChange(c) {
  const line = changeStartLine(c);
  const ed = diffEditor.getModifiedEditor();
  ed.setPosition({ lineNumber: line, column: 1 });
  ed.revealLineInCenterIfOutsideViewport(line, monaco.editor.ScrollType.Smooth);
  ed.focus();
}

// IntelliJ F7 flow: step through differences; at the last one, a hint arms a
// second F7 press to jump to the first difference of the next file.
function nextDifference() {
  if (!state.current) {
    selectFileByOffset(1);
    return;
  }
  const changes = getLineChanges();
  const line = diffEditor.getModifiedEditor().getPosition()?.lineNumber || 0;
  const next = changes.find((c) => changeStartLine(c) > line);
  state.shiftF7Armed = false;
  if (next) {
    state.f7Armed = false;
    gotoChange(next);
  } else if (state.f7Armed || changes.length === 0) {
    state.f7Armed = false;
    if (!selectFileByOffset(1)) toast('No more changed files');
  } else {
    state.f7Armed = true;
    toast(`Press ${actionShortcut('next-diff')} to go to the next file`);
  }
}

function prevDifference() {
  if (!state.current) {
    selectFileByOffset(-1, true);
    return;
  }
  const changes = getLineChanges();
  const line = diffEditor.getModifiedEditor().getPosition()?.lineNumber || Infinity;
  const prev = [...changes].reverse().find((c) => changeStartLine(c) < line);
  state.f7Armed = false;
  if (prev) {
    state.shiftF7Armed = false;
    gotoChange(prev);
  } else if (state.shiftF7Armed || changes.length === 0) {
    state.shiftF7Armed = false;
    if (!selectFileByOffset(-1, true)) toast('No more changed files');
  } else {
    state.shiftF7Armed = true;
    toast(`Press ${actionShortcut('prev-diff')} to go to the previous file`);
  }
}

// ------------------------------------------------------------------ status

async function refreshStatus(keepDiff) {
  if (!state.repo) return;
  let st;
  try {
    st = await window.api.gitStatus();
  } catch (err) {
    toast('git status failed: ' + err.message, true);
    return;
  }
  state.branch = st.branch;
  state.files = st.files;
  $('status-branch').textContent = st.branch;

  // New files default to checked, like IntelliJ's commit window.
  for (const f of st.files) {
    if (!state.known.has(f.path)) {
      state.known.add(f.path);
      state.checked.add(f.path);
    }
  }
  const paths = new Set(st.files.map((f) => f.path));
  for (const p of [...state.checked]) if (!paths.has(p)) state.checked.delete(p);

  renderTree();

  if (state.current) {
    const cur = st.files.find((f) => f.path === state.current.path);
    if (!cur) {
      // File no longer changed (committed / rolled back) — clear the diff.
      state.current = null;
      disposeModels();
      $('diff-file-path').textContent = 'No file selected';
      $('diff-file-path').classList.add('dim');
      $('diff-file-icon').textContent = '';
      $('diff-dirty').textContent = '';
      $('diff-count').textContent = '';
      $('diff-empty').classList.remove('hidden');
      $('empty-hint').innerHTML =
        'Select a changed file — <kbd>↑</kbd><kbd>↓</kbd> in the tree, <kbd>F7</kbd> to step through diffs';
    } else if (!keepDiff && !state.dirty) {
      // Reload the open diff (e.g. file changed on disk) preserving position.
      const pos = diffEditor && diffEditor.getModifiedEditor().getPosition();
      const scroll = diffEditor && diffEditor.getModifiedEditor().getScrollTop();
      openDiff(cur).then(() => {
        if (pos) {
          const ed = diffEditor.getModifiedEditor();
          ed.setPosition(pos);
          ed.setScrollTop(scroll);
        }
      });
    }
  }
}

// ------------------------------------------------------------------- repo

async function setRepo(repo) {
  if (!repo) return;
  state.repo = repo;
  state.known.clear();
  state.checked.clear();
  state.collapsed.clear();
  state.current = null;
  disposeModels();
  $('titlebar-repo').textContent = repo.name;
  $('status-path').textContent = repo.root;
  document.title = `${repo.name} – Diffier`;
  $('diff-empty').classList.remove('hidden');
  $('empty-hint').innerHTML =
    'Select a changed file — <kbd>↑</kbd><kbd>↓</kbd> in the tree, <kbd>F7</kbd> to step through diffs';
  await refreshStatus();
  // Auto-select the first changed file, like opening IntelliJ's diff preview.
  const rows = fileRows();
  if (rows.length) selectRow(rows[0].key);
  treeEl.focus();
}

async function openRepoDialog() {
  try {
    const repo = await window.api.openRepoDialog();
    if (repo) await setRepo(repo);
  } catch (err) {
    toast(err.message, true);
  }
}

// ------------------------------------------------------------- git actions

async function doCommit(alsoPush) {
  await autosaveIfDirty();
  const files = state.files
    .filter((f) => state.checked.has(f.path))
    .flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));
  const message = $('commit-message').value;
  const amend = $('amend-checkbox').checked;
  if (!files.length) {
    toast('No files selected for commit', true);
    return;
  }
  if (!message.trim() && !amend) {
    toast('Specify commit message', true);
    $('commit-message').focus();
    return;
  }
  try {
    $('btn-commit').disabled = true;
    $('btn-commit-push').disabled = true;
    await window.api.gitCommit({ files, message, amend });
    const subject = message.split('\n')[0].slice(0, 60);
    $('commit-message').value = '';
    $('amend-checkbox').checked = false;
    statusMsg('');
    if (alsoPush) {
      statusMsg('Pushing…');
      await window.api.gitPush();
      statusMsg('');
      toast(`Committed and pushed: ${subject || '(amend)'}`);
    } else {
      toast(`Committed: ${subject || '(amend)'}`);
    }
    await refreshStatus();
  } catch (err) {
    toast(err.message, true);
  } finally {
    updateCommitCount();
  }
}

async function doPush() {
  try {
    statusMsg('Pushing…');
    const out = await window.api.gitPush();
    statusMsg('');
    toast(out.trim() ? out.trim().split('\n').pop() : 'Pushed');
  } catch (err) {
    statusMsg('');
    toast('Push failed: ' + err.message, true);
  }
}

async function doRollback() {
  const row = selectedRow();
  if (!row) return;
  const files = row.kind === 'file' ? [row.file] : collectFiles(row.node);
  if (!files.length) return;
  const names = files.length === 1 ? files[0].path : `${files.length} files`;
  const ok = await window.api.confirm({
    message: `Rollback ${names}?`,
    detail: 'Local changes will be reverted to the repository version. Unversioned files will be deleted.',
    confirmLabel: 'Rollback',
  });
  if (!ok) return;
  try {
    if (state.current && files.some((f) => f.path === state.current.path)) {
      setDirty(false); // don't autosave what we're about to revert
    }
    await window.api.gitRollback(files.map((f) => ({ path: f.path, type: f.type, origPath: f.origPath })));
    toast(`Rolled back ${names}`);
    await refreshStatus();
  } catch (err) {
    toast('Rollback failed: ' + err.message, true);
  }
}

// ---------------------------------------------------------------- actions

const ACTION_IMPL = {
  'next-diff': () => nextDifference(),
  'prev-diff': () => prevDifference(),
  'next-file': () => void selectFileByOffset(1),
  'prev-file': () => void selectFileByOffset(-1, true),
  'focus-tree': () => {
    state.f7Armed = false;
    state.shiftF7Armed = false;
    treeEl.focus();
  },
  commit: () => $('commit-message').focus(),
  'commit-execute': () => doCommit(false),
  'commit-and-push': () => doCommit(true),
  push: () => doPush(),
  rollback: () => doRollback(),
  save: () => saveCurrent(),
  'open-repo': () => openRepoDialog(),
  refresh: () => refreshStatus(),
  'toggle-panel': () => {
    const panel = $('commit-panel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) treeEl.focus();
  },
  'keymap-settings': () => toggleKeymapDialog(),
};

function runAction(id) {
  const impl = ACTION_IMPL[id];
  if (impl) impl();
}

// -------------------------------------------------------------- keybinding

// Fixed tree-navigation keys (not part of the customizable keymap).
function handleTreeKey(e) {
  if (document.activeElement !== treeEl) return false;
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  const row = selectedRow();
  switch (e.key) {
    case 'ArrowDown':
      moveSelection(1);
      return true;
    case 'ArrowUp':
      moveSelection(-1);
      return true;
    case 'ArrowRight':
      if (row && row.kind === 'dir' && state.collapsed.has(row.key)) toggleCollapse(row.key);
      else moveSelection(1);
      return true;
    case 'ArrowLeft':
      if (row && row.kind === 'dir' && !state.collapsed.has(row.key)) toggleCollapse(row.key);
      return true;
    case ' ':
      if (row) {
        if (row.kind === 'file') toggleChecked(row.file.path);
        else {
          const all = collectFiles(row.node);
          const anyUnchecked = all.some((f) => !state.checked.has(f.path));
          for (const f of all) {
            if (anyUnchecked) state.checked.add(f.path);
            else state.checked.delete(f.path);
          }
          renderTree();
        }
      }
      return true;
    case 'Enter':
      if (row && row.kind === 'file') focusEditor();
      else if (row) toggleCollapse(row.key);
      return true;
    default:
      return false;
  }
}

window.addEventListener(
  'keydown',
  (e) => {
    // Shortcut recording captures everything first.
    if (km.recordingAction) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return stopRecording();
      const b = eventToBinding(e);
      if (b) assignBinding(km.recordingAction, b);
      return;
    }

    // While the keymap dialog is open, only Escape (close) is handled.
    if (km.dialogOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeKeymapDialog();
      }
      return;
    }

    // Fixed tree navigation wins over the keymap when the tree has focus.
    if (handleTreeKey(e)) {
      e.preventDefault();
      return;
    }

    // Alt+Left/Right — fixed secondary binding for prev/next changed file
    // when the tree has focus (Option+arrow stays word navigation in text).
    if (
      e.altKey && !e.metaKey && !e.ctrlKey &&
      (e.key === 'ArrowRight' || e.key === 'ArrowLeft') &&
      document.activeElement === treeEl
    ) {
      e.preventDefault();
      selectFileByOffset(e.key === 'ArrowRight' ? 1 : -1, e.key === 'ArrowLeft');
      return;
    }

    // Customizable keymap.
    const b = eventToBinding(e);
    const actionId = b && km.byBinding.get(b);
    if (actionId && bindingAllowedHere(b)) {
      e.preventDefault();
      e.stopPropagation();
      runAction(actionId);
    }
  },
  true
);

window.addEventListener('blur', () => autosaveIfDirty());

// ------------------------------------------------------------ keymap dialog

function renderKeymapDialog() {
  const list = $('keymap-list');
  list.textContent = '';
  for (const a of KEYMAP_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'keymap-row';
    row.dataset.action = a.id;

    const label = document.createElement('span');
    label.className = 'keymap-label';
    label.textContent = a.label;
    row.appendChild(label);

    const overridden = Object.prototype.hasOwnProperty.call(km.overrides, a.id);

    if (overridden) {
      const marker = document.createElement('button');
      marker.className = 'icon-btn overridden-marker';
      marker.textContent = '↺';
      marker.title = `Reset to default (${prettyBinding(normalizeBinding(a.default))})`;
      marker.addEventListener('click', () => {
        delete km.overrides[a.id];
        saveKeymap();
        renderKeymapDialog();
      });
      row.appendChild(marker);
    }

    const clear = document.createElement('button');
    clear.className = 'icon-btn';
    clear.textContent = '✕';
    clear.title = 'Remove shortcut';
    clear.addEventListener('click', () => {
      km.overrides[a.id] = null;
      saveKeymap();
      renderKeymapDialog();
    });
    row.appendChild(clear);

    const chip = document.createElement('span');
    chip.className = 'keymap-shortcut';
    const norm = km.bindings.get(a.id);
    if (km.recordingAction === a.id) {
      chip.classList.add('recording');
      chip.textContent = 'Press shortcut…';
    } else if (!norm) {
      chip.classList.add('unbound');
      chip.textContent = 'None';
    } else {
      chip.textContent = prettyBinding(norm);
    }
    chip.addEventListener('click', () => {
      km.recordingAction = km.recordingAction === a.id ? null : a.id;
      renderKeymapDialog();
    });
    row.appendChild(chip);

    list.appendChild(row);
  }
}

function assignBinding(actionId, binding) {
  const norm = normalizeBinding(binding);
  // Steal the shortcut from whichever action currently holds it.
  const holder = km.byBinding.get(norm);
  if (holder && holder !== actionId) {
    km.overrides[holder] = null;
    const held = KEYMAP_ACTIONS.find((x) => x.id === holder);
    toast(`${prettyBinding(norm)} removed from “${held ? held.label : holder}”`);
  }
  // Store the default itself as "no override".
  if (normalizeBinding(kmDefault(actionId)) === norm) delete km.overrides[actionId];
  else km.overrides[actionId] = norm;
  km.recordingAction = null;
  saveKeymap();
  renderKeymapDialog();
}

function stopRecording() {
  km.recordingAction = null;
  renderKeymapDialog();
}

function openKeymapDialog() {
  km.dialogOpen = true;
  $('keymap-overlay').classList.remove('hidden');
  renderKeymapDialog();
}

function closeKeymapDialog() {
  km.dialogOpen = false;
  km.recordingAction = null;
  $('keymap-overlay').classList.add('hidden');
  treeEl.focus();
}

function toggleKeymapDialog() {
  if (km.dialogOpen) closeKeymapDialog();
  else openKeymapDialog();
}

$('btn-keymap').addEventListener('click', openKeymapDialog);
(() => {
  const sel = $('theme-select');
  for (const t of Object.values(THEMES)) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.label;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => setTheme(sel.value));
})();
$('keymap-done').addEventListener('click', closeKeymapDialog);
$('keymap-reset-all').addEventListener('click', () => {
  km.overrides = {};
  km.recordingAction = null;
  saveKeymap();
  renderKeymapDialog();
});
$('keymap-overlay').addEventListener('mousedown', (e) => {
  if (e.target === $('keymap-overlay')) closeKeymapDialog();
});

// ---------------------------------------------------------------- menu ipc

window.api.onMenu(async (id) => {
  if (id === 'window-focus') return refreshStatus(true);
  if (id.startsWith('theme:')) return setTheme(id.slice('theme:'.length));
  runAction(id);
});

window.api.onRepoChanged(() => refreshStatus(state.dirty));

// ---------------------------------------------------------------- toolbar

$('btn-refresh').addEventListener('click', () => refreshStatus());
$('btn-rollback').addEventListener('click', doRollback);
$('btn-expand-all').addEventListener('click', () => {
  state.collapsed.clear();
  renderTree();
});
$('btn-collapse-all').addEventListener('click', () => {
  const walk = (rows) => {
    for (const r of rows) if (r.kind === 'dir') state.collapsed.add(r.key);
  };
  // Flatten with nothing collapsed to find every dir key.
  state.collapsed.clear();
  const all = [];
  flattenRows(buildTree(state.files), 0, '', all);
  walk(all);
  renderTree();
});
$('btn-next-diff').addEventListener('click', nextDifference);
$('btn-prev-diff').addEventListener('click', prevDifference);
$('btn-next-file').addEventListener('click', () => selectFileByOffset(1));
$('btn-prev-file').addEventListener('click', () => selectFileByOffset(-1, true));
$('btn-commit').addEventListener('click', () => doCommit(false));
$('btn-commit-push').addEventListener('click', () => doCommit(true));

$('viewer-mode').addEventListener('change', async (e) => {
  await monacoReady;
  const side = e.target.value === 'side';
  diffEditor.updateOptions({ renderSideBySide: side });
  window.api.setSettings({ viewMode: e.target.value });
});

$('btn-whitespace').addEventListener('click', async (e) => {
  await monacoReady;
  const btn = e.currentTarget;
  btn.classList.toggle('active');
  const ignore = btn.classList.contains('active');
  diffEditor.updateOptions({ ignoreTrimWhitespace: ignore });
  window.api.setSettings({ ignoreWhitespace: ignore });
});

$('amend-checkbox').addEventListener('change', async (e) => {
  if (e.target.checked && !$('commit-message').value.trim()) {
    try {
      $('commit-message').value = await window.api.gitLastMessage();
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------- splitter

(() => {
  const splitter = $('splitter');
  const panel = $('commit-panel');
  let dragging = false;
  splitter.addEventListener('mousedown', () => {
    dragging = true;
    document.body.style.cursor = 'col-resize';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.min(window.innerWidth * 0.6, Math.max(180, e.clientX));
    panel.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor = '';
      window.api.setSettings({ panelWidth: parseInt(panel.style.width, 10) || 300 });
    }
  });
})();

// -------------------------------------------------------------------- boot

(async () => {
  try {
    state.settings = await window.api.getSettings();
  } catch {
    state.settings = {};
  }
  if (state.settings.panelWidth) {
    $('commit-panel').style.width = state.settings.panelWidth + 'px';
  }
  if (state.settings.viewMode === 'unified') {
    $('viewer-mode').value = 'unified';
  }
  if (state.settings.ignoreWhitespace) {
    $('btn-whitespace').classList.add('active');
  }
  km.overrides = { ...(state.settings.keymap || {}) };
  rebuildKeymap();
  applyTheme(state.settings.theme || DEFAULT_THEME);
  await monacoReady;
  // Monaco may have initialized before settings arrived — reapply so the
  // editor theme matches the persisted choice.
  applyTheme(state.settings.theme || DEFAULT_THEME);
  diffEditor.updateOptions({
    renderSideBySide: state.settings.viewMode !== 'unified',
    ignoreTrimWhitespace: !!state.settings.ignoreWhitespace,
  });
  try {
    const repo = await window.api.openLastRepo();
    if (repo) await setRepo(repo);
  } catch {
    /* stay on the empty state */
  }
})();
