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

// ------------------------------------------------------------------ themes

const THEMES = window.api.themes || {};
const DEFAULT_THEME = window.api.defaultTheme || 'islands-dark';

function currentTheme() {
  const id = state.settings.theme;
  return THEMES[id] || THEMES[DEFAULT_THEME];
}

let shikiActive = false;

// Convert a Diffier theme into a TextMate theme for shiki: the monaco
// `colors` are already VS Code color keys, and the Monarch token rules map
// onto the equivalent TextMate scopes.
function toShikiTheme(t) {
  const ruleColor = (token) => {
    const r = t.monaco.rules.find((x) => x.token === token);
    return r && r.foreground ? '#' + r.foreground : undefined;
  };
  const fg = ruleColor('') || t.monaco.colors['editor.foreground'];
  const scopeMap = [
    [['comment', 'punctuation.definition.comment'], ruleColor('comment')],
    [['string', 'punctuation.definition.string', 'markup.inserted'], ruleColor('string')],
    [
      ['constant.numeric', 'constant.language', 'constant.character', 'constant.other'],
      ruleColor('number'),
    ],
    [
      ['keyword', 'keyword.operator.new', 'storage', 'storage.type', 'storage.modifier'],
      ruleColor('keyword'),
    ],
    [
      [
        'entity.name.type',
        'entity.name.class',
        'entity.name.function',
        'entity.name.namespace',
        'support.function',
        'support.class',
        'support.type',
      ],
      ruleColor('type'),
    ],
    [
      ['entity.name.tag', 'punctuation.definition.tag', 'entity.other.attribute-name'],
      ruleColor('tag'),
    ],
    [['markup.deleted', 'invalid'], t.vars['st-conflict']],
  ];
  return {
    name: 'diffier-' + t.id,
    type: t.monaco.base === 'vs' || t.monaco.base === 'hc-light' ? 'light' : 'dark',
    colors: { ...t.monaco.colors, 'editor.foreground': fg },
    settings: [
      { settings: { foreground: fg, background: t.monaco.colors['editor.background'] } },
      ...scopeMap
        .filter(([, color]) => color)
        .map(([scope, color]) => ({ scope, settings: { foreground: color } })),
    ],
  };
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
    if (shikiActive) {
      // shikiToMonaco registered one monaco theme per Diffier theme (with
      // TextMate token colors); its patched setTheme switches both.
      monaco.editor.setTheme('diffier-' + t.id);
    } else {
      monaco.editor.defineTheme('diffier-theme', t.monaco);
      monaco.editor.setTheme('diffier-theme');
    }
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
  $('btn-stash').title = 'Stash / Unstash…' + hint('stash');
  $('btn-blame').title = 'Blame Annotations' + hint('annotate');
  $('btn-msg-history').title = 'Commit Message History' + hint('commit-history');
  $('tab-log').title = 'Log' + hint('toggle-log');
  $('tree-filter').placeholder = 'Filter changes…' +
    (actionShortcut('filter') === 'None' ? '' : ` (${actionShortcut('filter')})`);
  $('status-branch').title = 'Branches' + hint('branches');
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
  require(['vs/editor/editor.main'], async () => {
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
    window.DiffierLanguages.register(monaco);
    if (window.DiffierShiki) {
      try {
        await window.DiffierShiki.init(monaco, Object.values(THEMES).map(toShikiTheme));
        shikiActive = true;
        window.__shikiActive = true; // surfaced for tests and support diagnostics
      } catch (err) {
        console.warn('Shiki highlighter unavailable, using built-in grammars:', err);
      }
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

    diffEditor.onDidUpdateDiff(() => {
      updateDiffCount();
      updateHunkDecorations();
    });

    // Hunk include/exclude checkboxes live in the glyph margin of the
    // modified editor (IntelliJ's partial-commit gutter).
    diffEditor.getModifiedEditor().updateOptions({ glyphMargin: true });
    diffEditor.getModifiedEditor().onMouseDown((e) => {
      if (
        !e.target ||
        e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        !e.target.element ||
        !e.target.element.classList.contains('hunk-check')
      ) {
        return;
      }
      const line = e.target.position.lineNumber;
      const c = getLineChanges().find((ch) => changeStartLine(ch) === line);
      if (c) toggleHunk(c);
    });

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

    // Blame annotations go stale as soon as the buffer is edited.
    resolve();
  });
});

function getLineChanges() {
  return (diffEditor && diffEditor.getLineChanges()) || [];
}

function updateDiffCount() {
  const el = $('diff-count');
  if (!state.current && !state.readOnlyDiff) {
    el.textContent = '';
    return;
  }
  const n = getLineChanges().length;
  el.textContent = n === 0 ? 'Contents are identical' : `${n} difference${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------- language

function languageFor(filePath, content) {
  return window.DiffierLanguages.detect(monaco, filePath, content);
}

// -------------------------------------------------------- partial staging
// Each diff hunk in the modified editor gets a gutter checkbox. Unchecked
// hunks are excluded from the next commit: the renderer builds the exact file
// content to commit (original text + checked hunks) and the main process
// records it through a temporary index.

function hunkKey(c) {
  return `${c.originalStartLineNumber}:${c.originalEndLineNumber}`;
}

// Partial staging only makes sense for a plain modified worktree file whose
// text diff is currently in the editor.
function hunkStagingActive() {
  return !!(
    state.current &&
    state.current.type === 'MODIFIED' &&
    !state.current.origPath &&
    !state.readOnlyDiff &&
    !state.conflict &&
    originalModel &&
    modifiedModel &&
    // A diff update for the previous file can fire after state.current moved
    // on; without this the wrong file's hunks would be (re)attributed.
    currentModelsPath === state.current.path
  );
}

let hunkDecorationIds = [];

function updateHunkDecorations() {
  if (!diffEditor) return;
  const ed = diffEditor.getModifiedEditor();
  if (!hunkStagingActive()) {
    hunkDecorationIds = ed.deltaDecorations(hunkDecorationIds, []);
    return;
  }
  const changes = getLineChanges();
  const p = state.current.path;
  let entry = state.hunks.get(p);
  if (entry) {
    // Drop exclusions for hunks that no longer exist (file edited/reloaded).
    const valid = new Set(changes.map(hunkKey));
    for (const k of [...entry.excluded]) if (!valid.has(k)) entry.excluded.delete(k);
    if (!entry.excluded.size) {
      state.hunks.delete(p);
      entry = null;
    }
  }
  const excluded = entry ? entry.excluded : new Set();
  hunkDecorationIds = ed.deltaDecorations(
    hunkDecorationIds,
    changes.map((c) => {
      const line = changeStartLine(c);
      const off = excluded.has(hunkKey(c));
      return {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: 'hunk-check ' + (off ? 'unchecked' : 'checked'),
          glyphMarginHoverMessage: {
            value: off ? 'Excluded from commit — click to include' : 'Included in commit — click to exclude',
          },
        },
      };
    })
  );
  if (entry) {
    entry.total = changes.length;
    entry.content = buildPartialContent(changes, excluded);
    // Snapshots let doCommit detect that the file changed on disk after the
    // hunk selection was made (while its diff was not open).
    entry.snapshotModified = modifiedModel.getValue();
    entry.snapshotOriginal = originalModel.getValue();
  }
  updateCommitCount();
}

function toggleHunk(c) {
  if (!hunkStagingActive()) return;
  const p = state.current.path;
  let entry = state.hunks.get(p);
  if (!entry) {
    entry = { excluded: new Set(), total: 0, content: '' };
    state.hunks.set(p, entry);
  }
  const k = hunkKey(c);
  if (entry.excluded.has(k)) entry.excluded.delete(k);
  else entry.excluded.add(k);
  updateHunkDecorations();
}

// Original content with only the checked hunks applied.
function buildPartialContent(changes, excluded) {
  const oLines = originalModel.getLinesContent();
  const mLines = modifiedModel.getLinesContent();
  const eol = modifiedModel.getEOL();
  const out = [];
  let oPos = 1; // 1-based cursor into original lines
  for (const c of changes) {
    const insertion = c.originalEndLineNumber === 0;
    const oStart = insertion ? c.originalStartLineNumber + 1 : c.originalStartLineNumber;
    const oEndEx = insertion ? oStart : c.originalEndLineNumber + 1;
    while (oPos < oStart) out.push(oLines[oPos++ - 1]);
    if (excluded.has(hunkKey(c))) {
      while (oPos < oEndEx) out.push(oLines[oPos++ - 1]); // keep original
    } else {
      if (c.modifiedEndLineNumber > 0) {
        for (let m = c.modifiedStartLineNumber; m <= c.modifiedEndLineNumber; m++) {
          out.push(mLines[m - 1]);
        }
      }
      oPos = oEndEx;
    }
  }
  while (oPos <= oLines.length) out.push(oLines[oPos++ - 1]);
  return out.join(eol);
}

// Split the checked files into full commits, partial (hunk-limited) commits,
// and files whose every hunk is excluded (nothing to commit).
function commitSelection() {
  const full = [];
  const partials = [];
  const skipped = [];
  for (const f of state.files) {
    if (!state.checked.has(f.path)) continue;
    const h = state.hunks.get(f.path);
    if (h && h.excluded.size && f.type === 'MODIFIED' && !f.origPath) {
      if (h.excluded.size >= h.total) skipped.push(f.path);
      else partials.push({ path: f.path, content: h.content });
    } else {
      full.push(f);
    }
  }
  return { full, partials, skipped };
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

// Files surviving the filter box (checkbox state always tracks all files).
function visibleFiles() {
  if (!state.filter) return state.files;
  const q = state.filter.toLowerCase();
  return state.files.filter((f) => f.path.toLowerCase().includes(q));
}

const TREE_ROW_H = 22;
const TREE_OVERSCAN = 8;

function buildRowEl(row) {
  const el = document.createElement('div');
  el.className = 'tree-row';
  el.dataset.key = row.key;
  el.style.paddingLeft = 6 + (row.depth + 1) * 14 + 'px';
  el.style.height = TREE_ROW_H + 'px';
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

    const partial = state.hunks.get(row.file.path);
    if (partial && partial.excluded.size) {
      const p = document.createElement('span');
      p.className = 'dir-count';
      p.textContent = `${partial.total - partial.excluded.size}/${partial.total} hunks`;
      p.title = 'Partially staged — unchecked hunks stay out of the commit';
      el.appendChild(p);
    }

    el.addEventListener('click', () => selectRow(row.key));
    el.addEventListener('dblclick', () => {
      selectRow(row.key);
      focusEditor();
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      selectRow(row.key);
      openFileContextMenu(e, row.file);
    });
  }
  return el;
}

function renderTree() {
  const files = visibleFiles();
  const tree = buildTree(files);
  const rows = [];
  flattenRows(tree, 0, '', rows);
  state.rows = rows;
  renderTreeWindow(files);
  updateCommitCount();
}

// Windowed rendering: only the rows in (and around) the viewport get DOM
// nodes, so repositories with thousands of changed files stay responsive.
function renderTreeWindow(files) {
  if (!files) files = visibleFiles();
  treeEl.textContent = '';

  if (!files.length) {
    const div = document.createElement('div');
    div.className = 'empty-msg';
    div.textContent = state.repo
      ? state.filter
        ? 'No changes match the filter'
        : 'No changes'
      : 'No repository open';
    treeEl.appendChild(div);
    return;
  }

  // Synthetic "Changes" root, like IntelliJ's changelist node.
  const rootRow = document.createElement('div');
  rootRow.className = 'tree-row';
  rootRow.style.paddingLeft = '6px';
  rootRow.style.height = TREE_ROW_H + 'px';
  const suffix = state.filter ? ` of ${state.files.length}` : '';
  rootRow.innerHTML =
    `<span class="tree-chevron">▾</span>` +
    `<span class="dir-name">Changes</span>` +
    `<span class="dir-count">${files.length}${suffix} file${files.length === 1 ? '' : 's'}</span>`;
  treeEl.appendChild(rootRow);

  const rows = state.rows;
  const viewH = treeEl.clientHeight || 600;
  const scrollTop = treeEl.scrollTop;
  const first = Math.max(0, Math.floor((scrollTop - TREE_ROW_H) / TREE_ROW_H) - TREE_OVERSCAN);
  const count = Math.ceil(viewH / TREE_ROW_H) + TREE_OVERSCAN * 2;
  const last = Math.min(rows.length, first + count);

  const padTop = document.createElement('div');
  padTop.style.height = first * TREE_ROW_H + 'px';
  treeEl.appendChild(padTop);
  for (let i = first; i < last; i++) treeEl.appendChild(buildRowEl(rows[i]));
  const padBottom = document.createElement('div');
  padBottom.style.height = Math.max(0, rows.length - last) * TREE_ROW_H + 'px';
  treeEl.appendChild(padBottom);
}

let treeScrollRaf = 0;
treeEl.addEventListener('scroll', () => {
  if (treeScrollRaf) return;
  treeScrollRaf = requestAnimationFrame(() => {
    treeScrollRaf = 0;
    renderTreeWindow();
  });
});

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
  const { partials, skipped } = commitSelection();
  let text = state.files.length ? `${n} of ${state.files.length} selected` : '';
  if (partials.length) text += `, ${partials.length} partial`;
  if (skipped.length) text += `, ${skipped.length} empty`;
  $('commit-count').textContent = text;
  const committable = n - skipped.length;
  $('btn-commit').disabled = committable <= 0;
  $('btn-commit-push').disabled = committable <= 0;
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
  // Scroll the row into view first — with the windowed tree the row may not
  // even have a DOM node until it is in the viewport.
  const idx = state.rows.findIndex((r) => r.key === key);
  if (idx >= 0) {
    const top = TREE_ROW_H + idx * TREE_ROW_H; // synthetic root row above
    if (top < treeEl.scrollTop) treeEl.scrollTop = top;
    else if (top + TREE_ROW_H > treeEl.scrollTop + treeEl.clientHeight) {
      treeEl.scrollTop = top + TREE_ROW_H - treeEl.clientHeight;
    }
  }
  renderTreeWindow();
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

// Switch the diff pane between its three content views.
function showPane(which) {
  $('diff-editor').style.display = which === 'diff' ? '' : 'none';
  $('conflict-editor').classList.toggle('hidden', which !== 'conflict');
  $('image-diff').classList.toggle('hidden', which !== 'image');
  $('conflict-bar').classList.toggle('hidden', which !== 'conflict');
}

function setDiffHeader(file, extra) {
  $('diff-file-path').textContent =
    (file.origPath ? `${file.origPath} → ${file.path}` : file.path) + (extra || '');
  $('diff-file-path').classList.remove('dim');
  const icon = $('diff-file-icon');
  icon.className = 'file-name ' + file.type;
  icon.textContent = TYPE_ICON[file.type] || '●';
  $('diff-empty').classList.add('hidden');
}

function showImageDiff(diff) {
  state.imageDiff = diff;
  const set = (imgId, missId, capId, b64) => {
    const img = $(imgId);
    if (b64) {
      img.src = `data:${diff.imageMime};base64,${b64}`;
      img.onload = () => {
        $(capId).textContent =
          `${img.naturalWidth}×${img.naturalHeight} · ${Math.round((b64.length * 3) / 4 / 1024)} KB`;
      };
      $(missId).classList.add('hidden');
    } else {
      img.removeAttribute('src');
      img.src = '';
      $(capId).textContent = '';
      $(missId).classList.remove('hidden');
    }
  };
  set('image-old', 'image-old-missing', 'image-old-caption', diff.originalImage);
  set('image-new', 'image-new-missing', 'image-new-caption', diff.modifiedImage);
  showPane('image');
  $('diff-count').textContent = '';
}

async function openDiff(file, revealEnd) {
  await monacoReady;
  await autosaveIfDirty();

  state.current = file;
  state.readOnlyDiff = null;
  state.f7Armed = false;
  state.shiftF7Armed = false;
  closeConflictSession();
  state.imageDiff = null;
  $('btn-image-view').classList.add('hidden');
  $('btn-image-view').classList.remove('active');

  setDiffHeader(file);

  if (file.type === 'CONFLICT') {
    setDirty(false);
    disposeModels();
    updateDiffCount();
    return openConflict(file);
  }

  let diff;
  try {
    diff = await window.api.gitDiff(file.path, file.type, file.origPath);
  } catch (err) {
    toast('Failed to load diff: ' + err.message, true);
    return;
  }
  if (state.current !== file || state.conflict) return; // user moved on while we loaded

  disposeModels();
  showPane('diff');

  if (diff.binary && diff.image) {
    setDirty(false);
    showImageDiff(diff);
    return;
  }

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

  const lang = languageFor(file.path, diff.modified || diff.original);
  originalModel = monaco.editor.createModel(diff.original, lang);
  modifiedModel = monaco.editor.createModel(diff.modified, lang);
  currentModelsPath = file.path;
  diffEditor.setModel({ original: originalModel, modified: modifiedModel });

  // Text file with an image preview available (SVG).
  if (diff.image) {
    state.imageDiff = diff;
    $('btn-image-view').classList.remove('hidden');
  }

  const editable = file.type !== 'DELETED';
  diffEditor.updateOptions({ readOnly: !editable });
  setDirty(false);

  modifiedModel.onDidChangeContent(() => {
    if (!suppressModelEvents) {
      setDirty(true);
      clearBlame(); // annotations are stale once the buffer is edited
    }
  });

  if (state.blameOn) applyBlame();

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

// Read-only diff of one file inside a commit (Log tab / file history).
async function openCommitFileDiff(commit, file) {
  await monacoReady;
  await autosaveIfDirty();

  state.current = null;
  state.readOnlyDiff = { hash: commit.hash, short: commit.short, path: file.path };
  state.f7Armed = false;
  state.shiftF7Armed = false;
  closeConflictSession();
  state.imageDiff = null;
  $('btn-image-view').classList.add('hidden');
  $('btn-image-view').classList.remove('active');

  setDiffHeader(file, ` @ ${commit.short}`);

  let diff;
  try {
    diff = await window.api.gitCommitFileDiff(commit.hash, file.path, file.type, file.origPath);
  } catch (err) {
    toast('Failed to load diff: ' + err.message, true);
    return;
  }
  if (
    !state.readOnlyDiff ||
    state.readOnlyDiff.hash !== commit.hash ||
    state.readOnlyDiff.path !== file.path
  ) {
    return; // user clicked another file while this diff loaded
  }

  disposeModels();
  showPane('diff');
  setDirty(false);

  if (diff.binary && diff.image) {
    showImageDiff(diff);
    return;
  }
  if (diff.binary || diff.tooLarge) {
    const note = diff.binary ? 'Binary file — cannot show diff' : 'File is too large to diff';
    originalModel = monaco.editor.createModel('', 'plaintext');
    modifiedModel = monaco.editor.createModel(note, 'plaintext');
  } else {
    const lang = languageFor(file.path, diff.modified || diff.original);
    originalModel = monaco.editor.createModel(diff.original, lang);
    modifiedModel = monaco.editor.createModel(diff.modified, lang);
  }
  diffEditor.setModel({ original: originalModel, modified: modifiedModel });
  diffEditor.updateOptions({ readOnly: true });

  const once = diffEditor.onDidUpdateDiff(() => {
    once.dispose();
    const changes = getLineChanges();
    if (changes.length) gotoChange(changes[0]);
    updateDiffCount();
  });
}

function disposeModels() {
  suppressModelEvents = true;
  if (diffEditor) diffEditor.setModel(null);
  if (originalModel) originalModel.dispose();
  if (modifiedModel) modifiedModel.dispose();
  originalModel = modifiedModel = null;
  currentModelsPath = null;
  suppressModelEvents = false;
}

function setDirty(d) {
  state.dirty = d;
  $('diff-dirty').textContent = d ? '*' : '';
}

function editableModel() {
  if (state.conflict && conflictModel) return conflictModel;
  if (state.current && !state.readOnlyDiff && modifiedModel) return modifiedModel;
  return null;
}

async function autosaveIfDirty() {
  const model = editableModel();
  if (!state.dirty || !state.current || !model) return;
  try {
    await window.api.saveFile(state.current.path, model.getValue());
    setDirty(false);
  } catch (err) {
    toast('Autosave failed: ' + err.message, true);
  }
}

async function saveCurrent() {
  const model = editableModel();
  if (!state.current || !model) return;
  try {
    await window.api.saveFile(state.current.path, model.getValue());
    setDirty(false);
    statusMsg('Saved ' + state.current.path);
    await refreshStatus(true);
  } catch (err) {
    toast('Save failed: ' + err.message, true);
  }
}

function focusEditor() {
  if (state.conflict && conflictEditor) conflictEditor.focus();
  else if (diffEditor && state.current) diffEditor.getModifiedEditor().focus();
}

// ----------------------------------------------------- conflict resolution
// Conflicted files open in a single editor over the working-tree file with
// the conflict regions parsed from the markers. Each region gets ours/theirs
// highlighting plus codelens actions (Accept Ours / Theirs / Both), with
// whole-file actions and Mark Resolved in the bar above.

let conflictDecorationIds = [];
let conflictLensEmitter = null;
let conflictReparseTimer = null;

function ensureConflictEditor() {
  if (conflictEditor) return;
  conflictEditor = monaco.editor.create($('conflict-editor'), {
    theme: shikiActive ? 'diffier-' + currentTheme().id : 'diffier-theme',
    automaticLayout: true,
    fontFamily: 'SF Mono, Menlo, Monaco, JetBrains Mono, Consolas, monospace',
    fontSize: 12,
    lineHeight: 19,
    scrollBeyondLastLine: false,
    minimap: { enabled: false },
    padding: { top: 4 },
    codeLens: true,
  });
  conflictEditor.onDidChangeModelContent(() => {
    if (suppressModelEvents) return;
    setDirty(true);
    clearTimeout(conflictReparseTimer);
    conflictReparseTimer = setTimeout(reparseConflicts, 150);
  });
  conflictEditor.onDidChangeCursorPosition(() => updateConflictCount());

  monaco.editor.registerCommand('diffier.conflict.ours', (_a, i) => acceptConflict(i, 'ours'));
  monaco.editor.registerCommand('diffier.conflict.theirs', (_a, i) => acceptConflict(i, 'theirs'));
  monaco.editor.registerCommand('diffier.conflict.both', (_a, i) => acceptConflict(i, 'both'));

  conflictLensEmitter = new monaco.Emitter();
  monaco.languages.registerCodeLensProvider('*', {
    onDidChange: conflictLensEmitter.event,
    provideCodeLenses: (model) => {
      if (!state.conflict || model !== conflictModel) return { lenses: [], dispose() {} };
      const { oursLabel, theirsLabel } = state.conflict.info;
      const lenses = [];
      state.conflict.regions.forEach((r, i) => {
        const range = new monaco.Range(r.start, 1, r.start, 1);
        lenses.push(
          { range, command: { id: 'diffier.conflict.ours', title: `Accept ${oursLabel}`, arguments: [i] } },
          { range, command: { id: 'diffier.conflict.theirs', title: `Accept ${theirsLabel}`, arguments: [i] } },
          { range, command: { id: 'diffier.conflict.both', title: 'Accept Both', arguments: [i] } }
        );
      });
      return { lenses, dispose() {} };
    },
    resolveCodeLens: (_m, lens) => lens,
  });
}

// <<<<<<< ours [||||||| base] ======= theirs >>>>>>>  (1-based line numbers)
function parseConflictRegions(model) {
  const regions = [];
  let cur = null;
  for (let i = 1; i <= model.getLineCount(); i++) {
    const l = model.getLineContent(i);
    if (l.startsWith('<<<<<<<')) cur = { start: i, base: 0, sep: 0, end: 0 };
    else if (cur && !cur.sep && l.startsWith('|||||||')) cur.base = i;
    else if (cur && !cur.sep && l.startsWith('=======')) cur.sep = i;
    else if (cur && cur.sep && l.startsWith('>>>>>>>')) {
      cur.end = i;
      regions.push(cur);
      cur = null;
    }
  }
  return regions;
}

function reparseConflicts() {
  if (!state.conflict || !conflictModel) return;
  const regions = parseConflictRegions(conflictModel);
  state.conflict.regions = regions;

  const decos = [];
  for (const r of regions) {
    const oursEnd = (r.base || r.sep) - 1;
    decos.push({
      range: new monaco.Range(r.start, 1, r.start, 1),
      options: { isWholeLine: true, className: 'conflict-marker-line' },
    });
    if (oursEnd >= r.start + 1) {
      decos.push({
        range: new monaco.Range(r.start + 1, 1, oursEnd, 1),
        options: { isWholeLine: true, className: 'conflict-ours-line', linesDecorationsClassName: 'conflict-ours-glyph' },
      });
    }
    if (r.base && r.sep - 1 >= r.base + 1) {
      decos.push({
        range: new monaco.Range(r.base + 1, 1, r.sep - 1, 1),
        options: { isWholeLine: true, className: 'conflict-base-line' },
      });
    }
    decos.push({
      range: new monaco.Range(r.sep, 1, r.sep, 1),
      options: { isWholeLine: true, className: 'conflict-marker-line' },
    });
    if (r.end - 1 >= r.sep + 1) {
      decos.push({
        range: new monaco.Range(r.sep + 1, 1, r.end - 1, 1),
        options: { isWholeLine: true, className: 'conflict-theirs-line', linesDecorationsClassName: 'conflict-theirs-glyph' },
      });
    }
    decos.push({
      range: new monaco.Range(r.end, 1, r.end, 1),
      options: { isWholeLine: true, className: 'conflict-marker-line' },
    });
  }
  conflictDecorationIds = conflictModel.deltaDecorations(conflictDecorationIds, decos);
  if (conflictLensEmitter) conflictLensEmitter.fire(null);
  updateConflictCount();
}

function updateConflictCount() {
  if (!state.conflict) return;
  const n = state.conflict.regions.length;
  const line = conflictEditor ? (conflictEditor.getPosition() || {}).lineNumber || 0 : 0;
  const idx = state.conflict.regions.findIndex((r) => line >= r.start && line <= r.end);
  $('conflict-count').textContent =
    n === 0
      ? 'No conflicts left'
      : idx >= 0
        ? `Conflict ${idx + 1} of ${n}`
        : `${n} conflict${n === 1 ? '' : 's'}`;
  // Mark Resolved stays enabled even with regions left: markResolved()
  // confirms first, and marker-lookalike content must not hard-block a file.
  $('btn-mark-resolved').disabled = false;
  $('btn-all-ours').disabled = n === 0;
  $('btn-all-theirs').disabled = n === 0;
  $('btn-prev-conflict').disabled = n === 0;
  $('btn-next-conflict').disabled = n === 0;
}

function conflictRegionText(r, which) {
  const lines = [];
  const push = (from, to) => {
    for (let i = from; i <= to; i++) lines.push(conflictModel.getLineContent(i));
  };
  const oursEnd = (r.base || r.sep) - 1;
  if (which === 'ours' || which === 'both') push(r.start + 1, oursEnd);
  if (which === 'theirs' || which === 'both') push(r.sep + 1, r.end - 1);
  return lines;
}

function acceptConflict(i, which) {
  if (!state.conflict) return;
  const r = state.conflict.regions[i];
  if (!r) return;
  const lines = conflictRegionText(r, which);
  const endCol = conflictModel.getLineMaxColumn(r.end);
  let range;
  let text;
  if (lines.length) {
    range = new monaco.Range(r.start, 1, r.end, endCol);
    text = lines.join(conflictModel.getEOL());
  } else if (r.end < conflictModel.getLineCount()) {
    // Accepted side is empty (e.g. "deleted in ours") — remove the region's
    // lines including the trailing newline, not leaving a blank line behind.
    range = new monaco.Range(r.start, 1, r.end + 1, 1);
    text = '';
  } else if (r.start > 1) {
    range = new monaco.Range(r.start - 1, conflictModel.getLineMaxColumn(r.start - 1), r.end, endCol);
    text = '';
  } else {
    range = new monaco.Range(r.start, 1, r.end, endCol);
    text = '';
  }
  conflictModel.pushEditOperations([], [{ range, text }], () => null);
  reparseConflicts();
}

function acceptAllConflicts(which) {
  if (!state.conflict) return;
  // Bottom-up so earlier regions keep their line numbers.
  for (let i = state.conflict.regions.length - 1; i >= 0; i--) acceptConflict(i, which);
}

function gotoConflict(delta) {
  if (!state.conflict || !state.conflict.regions.length) return;
  const regions = state.conflict.regions;
  const line = (conflictEditor.getPosition() || { lineNumber: 0 }).lineNumber;
  let target;
  if (delta > 0) target = regions.find((r) => r.start > line) || regions[0];
  else target = [...regions].reverse().find((r) => r.start < line) || regions[regions.length - 1];
  conflictEditor.setPosition({ lineNumber: target.start, column: 1 });
  conflictEditor.revealLineInCenterIfOutsideViewport(target.start);
  conflictEditor.focus();
  updateConflictCount();
}

async function openConflict(file) {
  let info;
  try {
    info = await window.api.gitConflictInfo(file.path);
  } catch (err) {
    toast('Failed to load conflict: ' + err.message, true);
    return;
  }
  if (state.current !== file) return;
  ensureConflictEditor();
  if (conflictModel) conflictModel.dispose();
  suppressModelEvents = true;
  conflictModel = monaco.editor.createModel(info.worktree, languageFor(file.path, info.worktree));
  conflictEditor.setModel(conflictModel);
  suppressModelEvents = false;
  conflictDecorationIds = [];
  state.conflict = { path: file.path, info, regions: [] };
  $('btn-all-ours').textContent = `Accept All ${info.oursLabel}`;
  $('btn-all-theirs').textContent = `Accept All ${info.theirsLabel}`;
  showPane('conflict');
  reparseConflicts();
  if (state.conflict.regions.length) {
    const r = state.conflict.regions[0];
    conflictEditor.setPosition({ lineNumber: r.start, column: 1 });
    conflictEditor.revealLineInCenterIfOutsideViewport(r.start);
  }
  $('diff-count').textContent = '';
}

function closeConflictSession() {
  if (!state.conflict) return;
  state.conflict = null;
  if (conflictModel) {
    suppressModelEvents = true;
    if (conflictEditor) conflictEditor.setModel(null);
    conflictModel.dispose();
    conflictModel = null;
    suppressModelEvents = false;
  }
  $('conflict-bar').classList.add('hidden');
}

async function markResolved() {
  if (!state.conflict || !conflictModel) return;
  if (state.conflict.regions.length) {
    const ok = await window.api.confirm({
      message: 'Conflict markers remain in the file',
      detail: 'Mark it resolved anyway? The markers will be committed as-is.',
      confirmLabel: 'Mark Resolved',
    });
    if (!ok) return;
  }
  try {
    await window.api.gitMarkResolved(state.conflict.path, conflictModel.getValue());
    setDirty(false);
    toast('Resolved ' + state.conflict.path);
    await refreshStatus();
  } catch (err) {
    toast('Mark resolved failed: ' + err.message, true);
  }
}

// ------------------------------------------------------------------- blame

let blameDecorationIds = [];

function clearBlame() {
  if (!blameDecorationIds.length || !diffEditor) return;
  blameDecorationIds = diffEditor.getModifiedEditor().deltaDecorations(blameDecorationIds, []);
}

async function applyBlame() {
  if (
    !state.current ||
    state.readOnlyDiff ||
    state.conflict ||
    !modifiedModel ||
    state.current.type === 'DELETED' ||
    state.current.type === 'UNVERSIONED'
  ) {
    clearBlame();
    return;
  }
  await autosaveIfDirty();
  const file = state.current;
  let lines;
  try {
    lines = await window.api.gitBlame(file.path);
  } catch (err) {
    toast('Blame failed: ' + err.message, true);
    return;
  }
  if (!state.blameOn || state.current !== file || !modifiedModel) return;
  const decos = [];
  const max = Math.min(lines.length, modifiedModel.getLineCount());
  for (let i = 0; i < max; i++) {
    const b = lines[i];
    const col = modifiedModel.getLineMaxColumn(i + 1);
    const date = b.time ? new Date(b.time).toISOString().slice(0, 10) : '';
    const text = b.uncommitted
      ? '    · not committed'
      : `    · ${b.author} ${date} ${b.sha}`;
    decos.push({
      range: new monaco.Range(i + 1, col, i + 1, col),
      // showIfCollapsed: injected text on an empty (collapsed) range is
      // filtered out of rendering without it.
      options: { showIfCollapsed: true, after: { content: text, inlineClassName: 'blame-inline' } },
    });
  }
  blameDecorationIds = diffEditor.getModifiedEditor().deltaDecorations(blameDecorationIds, decos);
}

function toggleBlame() {
  state.blameOn = !state.blameOn;
  $('btn-blame').classList.toggle('active', state.blameOn);
  if (state.blameOn) applyBlame();
  else clearBlame();
}

// -------------------------------------------------------- diff navigation

function changeStartLine(c) {
  // For pure deletions modifiedEndLineNumber is 0 and the change anchors
  // after modifiedStartLineNumber — which for a deletion at EOF would point
  // past the last line, so clamp to the model.
  const line = c.modifiedEndLineNumber > 0 ? c.modifiedStartLineNumber : c.modifiedStartLineNumber + 1;
  const model = diffEditor && diffEditor.getModifiedEditor().getModel();
  const max = model ? model.getLineCount() : Infinity;
  return Math.max(1, Math.min(line, max));
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
  state.track = st.track;
  state.files = st.files;
  $('status-branch').textContent = st.branch;
  $('status-track').textContent = st.track
    ? [st.track.ahead ? `↑${st.track.ahead}` : '', st.track.behind ? `↓${st.track.behind}` : '']
        .filter(Boolean)
        .join(' ')
    : '';

  if (window.api.setBadge) {
    Promise.resolve(window.api.setBadge(st.files.length)).catch(() => {});
  }

  // New files default to checked, like IntelliJ's commit window.
  for (const f of st.files) {
    if (!state.known.has(f.path)) {
      state.known.add(f.path);
      state.checked.add(f.path);
    }
  }
  const paths = new Set(st.files.map((f) => f.path));
  for (const p of [...state.checked]) if (!paths.has(p)) state.checked.delete(p);
  for (const p of [...state.hunks.keys()]) if (!paths.has(p)) state.hunks.delete(p);

  renderTree();

  if (state.readOnlyDiff) return; // a commit diff from the Log tab is showing

  if (state.current) {
    const cur = st.files.find((f) => f.path === state.current.path);
    if (!cur) {
      // File no longer changed (committed / rolled back) — clear the diff.
      clearDiffView();
    } else if (cur.type !== state.current.type) {
      // e.g. a conflict was resolved or re-appeared — reopen in the right view.
      const key = 'file:' + cur.path;
      state.current = cur;
      if (state.selectedKey === key) openDiff(cur);
    } else if (!keepDiff && !state.dirty && !state.conflict) {
      // Reload the open diff (e.g. file changed on disk) preserving position.
      const pos = diffEditor && diffEditor.getModifiedEditor().getPosition();
      const scroll = diffEditor && diffEditor.getModifiedEditor().getScrollTop();
      openDiff(cur).then(() => {
        if (pos && modifiedModel) {
          const ed = diffEditor.getModifiedEditor();
          ed.setPosition(pos);
          ed.setScrollTop(scroll);
        }
      });
    }
  }
}

function clearDiffView() {
  state.current = null;
  state.readOnlyDiff = null;
  closeConflictSession();
  disposeModels();
  showPane('diff');
  $('btn-image-view').classList.add('hidden');
  $('diff-file-path').textContent = 'No file selected';
  $('diff-file-path').classList.add('dim');
  $('diff-file-icon').textContent = '';
  $('diff-dirty').textContent = '';
  $('diff-count').textContent = '';
  $('diff-empty').classList.remove('hidden');
  $('empty-hint').innerHTML =
    'Select a changed file — <kbd>↑</kbd><kbd>↓</kbd> in the tree, <kbd>F7</kbd> to step through diffs';
}

// ------------------------------------------------------------------- repo

async function setRepo(repo) {
  if (!repo) return;
  state.repo = repo;
  state.known.clear();
  state.checked.clear();
  state.collapsed.clear();
  state.hunks.clear();
  state.filter = '';
  $('tree-filter').value = '';
  $('tree-filter-clear').classList.add('hidden');
  state.log = { entries: [], skip: 0, done: false, loading: false, selected: null, details: null, filePath: null };
  clearDiffView();
  $('titlebar-repo').textContent = repo.name;
  $('titlebar-worktree').classList.toggle('hidden', !repo.isWorktree);
  $('status-path').textContent = repo.root;
  document.title = `${repo.name} – Diffier`;

  // Prefill the commit message from the repo's commit.template, if any.
  state.commitTemplate = '';
  try {
    if (window.api.gitCommitTemplate) state.commitTemplate = await window.api.gitCommitTemplate();
  } catch {
    /* optional */
  }
  const msgBox = $('commit-message');
  if (!msgBox.value.trim() && state.commitTemplate) {
    msgBox.value = state.commitTemplate;
    updateSubjectLength();
  }

  await refreshStatus();
  if (state.view === 'log') await loadLog(true);
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
  const { full, partials, skipped } = commitSelection();
  const files = full.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));
  const message = $('commit-message').value;
  const amend = $('amend-checkbox').checked;
  if (!files.length && !partials.length) {
    toast(
      skipped.length ? 'All hunks of the selected files are excluded' : 'No files selected for commit',
      true
    );
    return;
  }
  const conflicted = full.filter((f) => f.type === 'CONFLICT');
  if (conflicted.length) {
    toast(`Resolve conflicts before committing: ${conflicted[0].path}`, true);
    return;
  }
  // A hunk selection was computed against the file content at the time its
  // diff was open. If the file (or HEAD) changed since, the prepared partial
  // content would silently commit stale text — verify before committing.
  for (const p of partials) {
    const entry = state.hunks.get(p.path);
    if (!entry || entry.snapshotModified == null) continue;
    try {
      const d = await window.api.gitDiff(p.path, 'MODIFIED', null);
      if (d.modified !== entry.snapshotModified || d.original !== entry.snapshotOriginal) {
        state.hunks.delete(p.path);
        updateCommitCount();
        toast(`${p.path} changed since its hunks were selected — reopen it and reselect`, true);
        return;
      }
    } catch {
      /* diff unavailable — let the commit surface the error */
    }
  }
  // The commit message template is boilerplate, not a message.
  const effectiveMsg = message.trim() === state.commitTemplate.trim() ? '' : message;
  if (!effectiveMsg.trim() && !amend) {
    toast('Specify commit message', true);
    $('commit-message').focus();
    return;
  }
  try {
    $('btn-commit').disabled = true;
    $('btn-commit-push').disabled = true;
    await window.api.gitCommit({ files, message: effectiveMsg, amend, partials });
    const subject = effectiveMsg.split('\n')[0].slice(0, 60);
    rememberCommitMessage(effectiveMsg);
    $('commit-message').value = state.commitTemplate || '';
    updateSubjectLength();
    $('amend-checkbox').checked = false;
    for (const p of partials) state.hunks.delete(p.path);
    for (const f of full) state.hunks.delete(f.path);
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
    if (state.view === 'log') await loadLog(true);
  } catch (err) {
    toast(err.message, true);
  } finally {
    updateCommitCount();
  }
}

function rememberCommitMessage(message) {
  const msg = (message || '').trim();
  if (!msg) return;
  const history = [msg, ...(state.settings.commitHistory || []).filter((m) => m !== msg)].slice(0, 25);
  state.settings.commitHistory = history;
  window.api.setSettings({ commitHistory: history }).catch(() => {});
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

async function doPull() {
  try {
    statusMsg('Pulling…');
    const out = await window.api.gitPull();
    statusMsg('');
    toast(out.trim() ? out.trim().split('\n').pop() : 'Pulled');
    await refreshStatus();
    if (state.view === 'log') await loadLog(true);
  } catch (err) {
    statusMsg('');
    toast('Pull failed: ' + err.message, true);
  }
}

async function doFetch() {
  try {
    statusMsg('Fetching…');
    await window.api.gitFetch();
    statusMsg('');
    toast('Fetched');
    await refreshStatus();
  } catch (err) {
    statusMsg('');
    toast('Fetch failed: ' + err.message, true);
  }
}

// ------------------------------------------------------------------ popups

const POPUP_IDS = ['branch-popup', 'msg-history-popup', 'repo-popup', 'context-menu'];
// A popup's own anchor button must not close it on mousedown — otherwise the
// button's click handler sees a closed popup and immediately reopens it,
// making toggle-off impossible.
const POPUP_ANCHORS = {
  'branch-popup': 'status-branch',
  'msg-history-popup': 'btn-msg-history',
  'repo-popup': 'titlebar-repo',
};

function closePopups() {
  for (const id of POPUP_IDS) $(id).classList.add('hidden');
}

function anyPopupOpen() {
  return POPUP_IDS.some((id) => !$(id).classList.contains('hidden'));
}

window.addEventListener(
  'mousedown',
  (e) => {
    if (!anyPopupOpen()) return;
    for (const id of POPUP_IDS) {
      const el = $(id);
      if (el.classList.contains('hidden') || el.contains(e.target)) continue;
      const anchor = POPUP_ANCHORS[id] && $(POPUP_ANCHORS[id]);
      if (anchor && anchor.contains(e.target)) continue;
      el.classList.add('hidden');
    }
  },
  true
);

function positionPopup(el, opts) {
  el.classList.remove('hidden');
  const { anchor, align } = opts;
  const r = anchor.getBoundingClientRect();
  el.style.left = el.style.right = el.style.top = el.style.bottom = 'auto';
  if (align === 'above-right') {
    el.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    el.style.bottom = window.innerHeight - r.top + 6 + 'px';
  } else if (align === 'below') {
    el.style.left = Math.min(r.left, window.innerWidth - el.offsetWidth - 8) + 'px';
    el.style.top = r.bottom + 6 + 'px';
  } else if (align === 'above-left') {
    el.style.left = Math.min(r.left, window.innerWidth - el.offsetWidth - 8) + 'px';
    el.style.bottom = window.innerHeight - r.top + 6 + 'px';
  }
}

function popupItem(label, opts = {}) {
  const item = document.createElement('div');
  item.className = 'popup-item' + (opts.section ? ' section' : '');
  if (opts.icon) {
    const ic = document.createElement('span');
    ic.textContent = opts.icon;
    item.appendChild(ic);
  }
  const lbl = document.createElement('span');
  lbl.className = 'item-label';
  lbl.textContent = label;
  if (opts.title) item.title = opts.title;
  item.appendChild(lbl);
  if (opts.detail) {
    const d = document.createElement('span');
    d.className = 'dim';
    d.textContent = opts.detail;
    item.appendChild(d);
  }
  if (opts.onClick) {
    item.addEventListener('click', () => {
      closePopups();
      opts.onClick();
    });
  }
  return item;
}

// ------------------------------------------------------------ branch popup

const branchState = { branches: null, active: 0, items: [] };

async function openBranchPopup() {
  if (!state.repo) return;
  let br;
  try {
    br = await window.api.gitBranches();
  } catch (err) {
    toast('Failed to list branches: ' + err.message, true);
    return;
  }
  branchState.branches = br;
  branchState.active = 0;
  const popup = $('branch-popup');
  $('branch-filter').value = '';
  renderBranchList();
  positionPopup(popup, { anchor: $('status-branch'), align: 'above-right' });
  $('branch-filter').focus();
}

function renderBranchList() {
  const q = $('branch-filter').value.trim().toLowerCase();
  const br = branchState.branches;
  const list = $('branch-list');
  list.textContent = '';
  branchState.items = [];

  const addItem = (el, action) => {
    el.dataset.idx = String(branchState.items.length);
    if (branchState.items.length === branchState.active) el.classList.add('active');
    el.addEventListener('click', () => {
      closePopups();
      action();
    });
    branchState.items.push({ el, action });
    list.appendChild(el);
  };

  const locals = br.locals.filter((b) => !q || b.name.toLowerCase().includes(q));
  const remotes = br.remotes.filter((n) => !q || n.toLowerCase().includes(q));

  const newName = $('branch-filter').value.trim();
  const exact = br.locals.some((b) => b.name === newName);
  if (newName && !exact && /^[^\s~^:?*[\\]+$/.test(newName)) {
    const el = popupItem(`Create branch “${newName}”`, { icon: '＋' });
    addItem(el, () => checkoutBranch(newName, true));
  }

  if (locals.length) list.appendChild(popupItem('Local branches', { section: true }));
  for (const b of locals) {
    const el = popupItem(b.name, {
      icon: b.current ? '✓' : '⎇',
      detail: b.track ? b.track.replace(/[[\]]/g, '') : '',
      title: b.upstream ? `Upstream: ${b.upstream}` : '',
    });
    addItem(el, () => (b.current ? null : checkoutBranch(b.name, false)));
  }
  if (remotes.length) list.appendChild(popupItem('Remote branches', { section: true }));
  for (const name of remotes.slice(0, 50)) {
    const local = name.split('/').slice(1).join('/');
    const el = popupItem(name, { icon: '☁', title: `Checkout as “${local}”` });
    addItem(el, () => checkoutBranch(local, false));
  }
  if (!branchState.items.length) {
    list.appendChild(popupItem('No matching branches', { section: true }));
  }
}

async function checkoutBranch(name, create) {
  await autosaveIfDirty();
  try {
    statusMsg((create ? 'Creating ' : 'Checking out ') + name + '…');
    if (create) await window.api.gitCreateBranch(name);
    else await window.api.gitCheckout(name);
    statusMsg('');
    toast((create ? 'Created branch ' : 'Switched to ') + name);
    await refreshStatus();
    if (state.view === 'log') await loadLog(true);
  } catch (err) {
    statusMsg('');
    toast('Checkout failed: ' + err.message, true);
  }
}

$('branch-filter').addEventListener('input', () => {
  branchState.active = 0;
  renderBranchList();
});
$('branch-filter').addEventListener('keydown', (e) => {
  const items = branchState.items;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    if (!items.length) return;
    branchState.active =
      (branchState.active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items.forEach((it, i) => it.el.classList.toggle('active', i === branchState.active));
    items[branchState.active].el.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey) {
      const name = $('branch-filter').value.trim();
      if (name) {
        closePopups();
        checkoutBranch(name, true);
      }
      return;
    }
    const it = items[branchState.active];
    if (it) {
      closePopups();
      it.action();
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closePopups();
    treeEl.focus();
  }
});
$('status-branch').addEventListener('click', () => {
  if ($('branch-popup').classList.contains('hidden')) openBranchPopup();
  else closePopups();
});

// ----------------------------------------------------- commit msg history

function openMsgHistory() {
  const history = state.settings.commitHistory || [];
  const list = $('msg-history-list');
  list.textContent = '';
  if (!history.length) {
    const empty = document.createElement('div');
    empty.className = 'stash-empty';
    empty.textContent = 'No previous commit messages';
    list.appendChild(empty);
  }
  for (const msg of history) {
    const item = document.createElement('div');
    item.className = 'msg-history-item';
    item.textContent = msg.length > 300 ? msg.slice(0, 300) + '…' : msg;
    item.title = msg;
    item.addEventListener('click', () => {
      closePopups();
      $('commit-message').value = msg;
      updateSubjectLength();
      $('commit-message').focus();
    });
    list.appendChild(item);
  }
  positionPopup($('msg-history-popup'), { anchor: $('commit-message'), align: 'above-left' });
}

function toggleMsgHistory() {
  if ($('msg-history-popup').classList.contains('hidden')) openMsgHistory();
  else closePopups();
}

function updateSubjectLength() {
  const subject = ($('commit-message').value.split('\n')[0] || '').length;
  const el = $('subject-length');
  el.textContent = subject ? String(subject) : '';
  el.classList.toggle('warn', subject > 50 && subject <= 72);
  el.classList.toggle('over', subject > 72);
  el.title = 'Subject line length — aim for ≤50, hard-wrap at 72';
}

$('commit-message').addEventListener('input', updateSubjectLength);
$('btn-msg-history').addEventListener('click', toggleMsgHistory);

// ------------------------------------------------------------ repo popup

function openRepoPopup() {
  const list = $('repo-list');
  list.textContent = '';
  const recents = (state.repo && state.repo.recents) || state.settings.recentRepos || [];
  if (recents.length) list.appendChild(popupItem('Recent repositories', { section: true }));
  for (const dir of recents) {
    const name = dir.split('/').pop();
    const el = popupItem(name, {
      icon: state.repo && state.repo.root === dir ? '✓' : '▸',
      detail: dir,
      title: dir,
    });
    el.addEventListener('click', async () => {
      closePopups();
      if (state.repo && state.repo.root === dir) return;
      try {
        const repo = await window.api.openRepo(dir);
        await setRepo(repo);
      } catch (err) {
        toast(err.message, true);
      }
    });
    list.appendChild(el);
  }
  const sep = document.createElement('div');
  sep.className = 'popup-sep';
  list.appendChild(sep);
  list.appendChild(popupItem('Open Repository…', { icon: '📂', onClick: () => openRepoDialog() }));
  positionPopup($('repo-popup'), { anchor: $('titlebar-repo'), align: 'below' });
}

$('titlebar-repo').addEventListener('click', () => {
  if ($('repo-popup').classList.contains('hidden')) openRepoPopup();
  else closePopups();
});

// ------------------------------------------------------------ context menu

function openFileContextMenu(e, file) {
  const menu = $('context-menu');
  menu.textContent = '';
  menu.appendChild(
    popupItem('Show History', { icon: '🕘', onClick: () => showFileHistory(file.path) })
  );
  menu.appendChild(
    popupItem('Show Blame', {
      icon: '👤',
      onClick: () => {
        if (!state.blameOn) toggleBlame();
      },
    })
  );
  const sep1 = document.createElement('div');
  sep1.className = 'popup-sep';
  menu.appendChild(sep1);
  menu.appendChild(popupItem('Rollback…', { icon: '↩', onClick: () => doRollback() }));
  const sep2 = document.createElement('div');
  sep2.className = 'popup-sep';
  menu.appendChild(sep2);
  menu.appendChild(
    popupItem('Copy Path', {
      icon: '📋',
      onClick: () => navigator.clipboard.writeText(file.path).catch(() => {}),
    })
  );
  menu.appendChild(
    popupItem('Reveal in Finder', {
      icon: '📁',
      onClick: () => window.api.revealFile(file.path).catch(() => {}),
    })
  );
  menu.classList.remove('hidden');
  menu.style.right = menu.style.bottom = 'auto';
  menu.style.left = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8) + 'px';
}

// ------------------------------------------------------------------ stash

let stashOpen = false;

async function renderStashList() {
  const list = $('stash-list');
  let stashes = [];
  try {
    stashes = await window.api.gitStashList();
  } catch (err) {
    toast('Failed to list stashes: ' + err.message, true);
  }
  list.textContent = '';
  if (!stashes.length) {
    const empty = document.createElement('div');
    empty.className = 'stash-empty';
    empty.textContent = 'No stashes';
    list.appendChild(empty);
    return;
  }
  for (const s of stashes) {
    const row = document.createElement('div');
    row.className = 'stash-row';
    const ref = document.createElement('span');
    ref.className = 'dim';
    ref.textContent = s.ref;
    row.appendChild(ref);
    const msg = document.createElement('span');
    msg.className = 'stash-msg';
    msg.textContent = s.message;
    msg.title = s.message + (s.time ? ` — ${new Date(s.time).toLocaleString()}` : '');
    row.appendChild(msg);
    const actions = document.createElement('span');
    actions.className = 'stash-actions';
    const mk = (label, fn, title) => {
      const b = document.createElement('button');
      b.className = 'icon-btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };
    mk('Pop', () => doStashOp('pop', s.ref), 'Apply and drop this stash');
    mk('Apply', () => doStashOp('apply', s.ref), 'Apply, keep the stash');
    mk('Drop', async () => {
      const ok = await window.api.confirm({
        message: `Drop ${s.ref}?`,
        detail: s.message,
        confirmLabel: 'Drop',
      });
      if (ok) doStashOp('drop', s.ref);
    }, 'Delete this stash');
    row.appendChild(actions);
    list.appendChild(row);
  }
}

async function doStashOp(op, ref) {
  try {
    if (op === 'pop') await window.api.gitStashPop(ref);
    else if (op === 'apply') await window.api.gitStashApply(ref);
    else if (op === 'drop') await window.api.gitStashDrop(ref);
    toast(`Stash ${op}: ${ref}`);
    await renderStashList();
    await refreshStatus();
  } catch (err) {
    toast(`Stash ${op} failed: ` + err.message, true);
  }
}

async function doStashPush() {
  await autosaveIfDirty();
  try {
    await window.api.gitStashPush($('stash-message').value, $('stash-untracked').checked);
    $('stash-message').value = '';
    toast('Stashed changes');
    await renderStashList();
    await refreshStatus();
  } catch (err) {
    toast('Stash failed: ' + err.message, true);
  }
}

function openStashDialog() {
  if (!state.repo) return;
  stashOpen = true;
  $('stash-overlay').classList.remove('hidden');
  renderStashList();
  $('stash-message').focus();
}

function closeStashDialog() {
  stashOpen = false;
  $('stash-overlay').classList.add('hidden');
  treeEl.focus();
}

$('btn-stash').addEventListener('click', openStashDialog);
$('btn-stash-push').addEventListener('click', doStashPush);
$('stash-done').addEventListener('click', closeStashDialog);
$('stash-overlay').addEventListener('mousedown', (e) => {
  if (e.target === $('stash-overlay')) closeStashDialog();
});
$('stash-message').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doStashPush();
  }
});

// --------------------------------------------------------------- log view

const LOG_PAGE = 200;
const LANE_W = 10;
const LOG_ROW_H = 24;
const LANE_COLORS = ['#3574f0', '#73bd79', '#ed7261', '#d9a343', '#43b9c9', '#b07fe8', '#f75464'];

function setView(view) {
  state.view = view;
  $('commit-view').classList.toggle('hidden', view !== 'commit');
  $('log-view').classList.toggle('hidden', view !== 'log');
  $('tab-commit').classList.toggle('active', view === 'commit');
  $('tab-log').classList.toggle('active', view === 'log');
  if (view === 'log') {
    if (!state.log.entries.length) loadLog(true);
    $('log-list').focus();
  } else {
    treeEl.focus();
  }
}

async function loadLog(reset) {
  if (!state.repo || state.log.loading) return;
  if (reset) {
    state.log.entries = [];
    state.log.skip = 0;
    state.log.done = false;
    state.log.selected = null;
    state.log.details = null;
    $('log-details').classList.add('hidden');
  }
  state.log.loading = true;
  try {
    const batch = await window.api.gitLog({
      skip: state.log.skip,
      limit: LOG_PAGE,
      path: state.log.filePath,
    });
    state.log.entries.push(...batch);
    state.log.skip += batch.length;
    if (batch.length < LOG_PAGE) state.log.done = true;
    // A followed file history is a sparse slice of the DAG — parents mostly
    // aren't in the list, so lanes would never close. Skip the graph there.
    if (!state.log.filePath) computeLogGraph(state.log.entries);
    renderLog();
  } catch (err) {
    toast('git log failed: ' + err.message, true);
  } finally {
    state.log.loading = false;
  }
}

// Lane assignment for the commit graph: each lane tracks the hash it expects
// next. A commit takes over the lane expecting it (or a free one), its first
// parent continues the lane, other lanes expecting it merge in, extra parents
// fork out to new lanes.
function computeLogGraph(entries) {
  let lanes = [];
  for (const c of entries) {
    const before = lanes.slice();
    let col = lanes.indexOf(c.hash);
    if (col === -1) {
      col = lanes.indexOf(null);
      if (col === -1) {
        col = lanes.length;
        lanes.push(null);
      }
    }
    const merging = [];
    lanes.forEach((h, i) => {
      if (h === c.hash && i !== col) {
        merging.push(i);
        lanes[i] = null;
      }
    });
    const forks = [];
    if (!c.parents.length) {
      lanes[col] = null;
    } else {
      lanes[col] = c.parents[0];
      for (let pi = 1; pi < c.parents.length; pi++) {
        const p = c.parents[pi];
        let pcol = lanes.indexOf(p);
        if (pcol === -1) {
          pcol = lanes.indexOf(null);
          if (pcol === -1) {
            pcol = lanes.length;
            lanes.push(null);
          }
          lanes[pcol] = p;
        }
        forks.push(pcol);
      }
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    c.graph = { col, before, after: lanes.slice(), merging, forks };
  }
}

function laneColor(i) {
  return LANE_COLORS[i % LANE_COLORS.length];
}

function logGraphSvg(c) {
  const g = c.graph;
  const width = (Math.max(g.before.length, g.after.length, g.col + 1)) * LANE_W;
  const x = (i) => i * LANE_W + LANE_W / 2;
  const mid = LOG_ROW_H / 2;
  const parts = [];
  const line = (x1, y1, x2, y2, color) =>
    parts.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5"/>`
    );
  // Lines from the row above.
  g.before.forEach((h, i) => {
    if (h === null) return;
    if (h === c.hash) line(x(i), 0, x(g.col), mid, laneColor(i)); // into the dot
    else line(x(i), 0, x(i), mid, laneColor(i));
  });
  // Lines continuing below.
  g.after.forEach((h, i) => {
    if (h === null) return;
    const isFork = g.forks.includes(i);
    const from = isFork || i === g.col ? g.col : i;
    line(x(from), mid, x(i), LOG_ROW_H, laneColor(i));
  });
  parts.push(
    `<circle cx="${x(g.col)}" cy="${mid}" r="3" fill="${laneColor(g.col)}" stroke="none"/>`
  );
  return `<svg class="log-graph" width="${width}" height="${LOG_ROW_H}" viewBox="0 0 ${width} ${LOG_ROW_H}">${parts.join('')}</svg>`;
}

function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400 * 2) return Math.round(s / 3600) + 'h';
  if (s < 86400 * 30) return Math.round(s / 86400) + 'd';
  return new Date(ts).toISOString().slice(0, 10);
}

function renderLog() {
  const list = $('log-list');
  list.textContent = '';

  const filterEl = $('log-file-filter');
  filterEl.classList.toggle('hidden', !state.log.filePath);
  if (state.log.filePath) $('log-file-filter-label').textContent = '🕘 ' + state.log.filePath;

  if (!state.log.entries.length) {
    const div = document.createElement('div');
    div.className = 'empty-msg';
    div.textContent = state.log.loading ? 'Loading…' : 'No commits';
    list.appendChild(div);
    return;
  }

  for (const c of state.log.entries) {
    const row = document.createElement('div');
    row.className = 'log-row';
    row.dataset.hash = c.hash;
    if (c.hash === state.log.selected) row.classList.add('selected');

    if (!state.log.filePath && c.graph) {
      const graph = document.createElement('span');
      graph.innerHTML = logGraphSvg(c);
      row.appendChild(graph.firstChild);
    }

    for (const ref of parseRefs(c.refs)) {
      const chip = document.createElement('span');
      chip.className = 'log-ref' + (ref.head ? ' head' : '');
      chip.textContent = ref.name;
      chip.title = ref.name;
      row.appendChild(chip);
    }

    const subject = document.createElement('span');
    subject.className = 'log-subject';
    subject.textContent = c.subject;
    subject.title = c.subject;
    row.appendChild(subject);

    const author = document.createElement('span');
    author.className = 'log-author dim';
    author.textContent = c.author;
    row.appendChild(author);

    const date = document.createElement('span');
    date.className = 'log-date dim';
    date.textContent = relTime(c.time);
    date.title = new Date(c.time).toLocaleString();
    row.appendChild(date);

    row.addEventListener('click', () => selectLogEntry(c));
    list.appendChild(row);
  }

  if (!state.log.done) {
    const more = document.createElement('div');
    more.className = 'log-more';
    more.textContent = state.log.loading ? 'Loading…' : 'Load more…';
    more.addEventListener('click', () => loadLog(false));
    list.appendChild(more);
  }
}

function parseRefs(refs) {
  if (!refs) return [];
  return refs
    .split(', ')
    .map((r) => {
      if (r.startsWith('HEAD -> ')) return { name: r.slice(8), head: true };
      if (r === 'HEAD') return { name: 'HEAD', head: true };
      if (r.startsWith('tag: ')) return { name: '🏷 ' + r.slice(5), head: false };
      return { name: r, head: false };
    })
    .slice(0, 3);
}

async function selectLogEntry(c) {
  state.log.selected = c.hash;
  for (const el of $('log-list').querySelectorAll('.log-row')) {
    el.classList.toggle('selected', el.dataset.hash === c.hash);
  }
  let det;
  try {
    det = await window.api.gitCommitDetails(c.hash);
  } catch (err) {
    toast('Failed to load commit: ' + err.message, true);
    return;
  }
  if (state.log.selected !== c.hash) return;
  state.log.details = det;
  renderLogDetails(det);
  // In file-history mode jump straight to this file's diff at that commit.
  // Older commits may know the file under a pre-rename path — only auto-open
  // when the commit actually touched the path we're following; the details
  // list still shows everything the commit changed.
  if (state.log.filePath) {
    const f =
      det.files.find((x) => x.path === state.log.filePath) ||
      det.files.find((x) => x.origPath === state.log.filePath);
    if (f) openCommitFileDiff(det, f);
  }
}

function renderLogDetails(det) {
  $('log-details').classList.remove('hidden');
  $('log-details-header').textContent = det.message;
  $('log-details-meta').textContent =
    `${det.short} · ${det.author} <${det.email}> · ${new Date(det.time).toLocaleString()}` +
    (det.parents.length > 1 ? ' · merge' : '');
  const filesEl = $('log-details-files');
  filesEl.textContent = '';
  for (const f of det.files) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.style.paddingLeft = '8px';

    const icon = document.createElement('span');
    icon.className = 'tree-icon file-name ' + f.type;
    icon.textContent = TYPE_ICON[f.type] || '●';
    row.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'file-name ' + f.type;
    name.textContent = f.path;
    name.title = f.origPath ? `${f.origPath} → ${f.path}` : f.path;
    row.appendChild(name);

    row.addEventListener('click', () => {
      for (const el of filesEl.querySelectorAll('.tree-row')) el.classList.remove('selected');
      row.classList.add('selected');
      openCommitFileDiff(det, f);
    });
    filesEl.appendChild(row);
  }
}

function showFileHistory(path) {
  state.log.filePath = path;
  setView('log');
  loadLog(true);
}

$('log-file-filter-clear').addEventListener('click', () => {
  state.log.filePath = null;
  loadLog(true);
});

$('log-list').addEventListener('scroll', () => {
  const el = $('log-list');
  if (state.log.done || state.log.loading) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) loadLog(false);
});

$('tab-commit').addEventListener('click', () => setView('commit'));
$('tab-log').addEventListener('click', () => setView('log'));

// ------------------------------------------------------------- tree filter

$('tree-filter').addEventListener('input', () => {
  state.filter = $('tree-filter').value.trim();
  $('tree-filter-clear').classList.toggle('hidden', !state.filter);
  renderTree();
});
$('tree-filter').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if ($('tree-filter').value) {
      $('tree-filter').value = '';
      state.filter = '';
      $('tree-filter-clear').classList.add('hidden');
      renderTree();
    } else {
      treeEl.focus();
    }
  } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
    e.preventDefault();
    treeEl.focus();
    const rows = fileRows();
    if (rows.length && !rows.some((r) => r.key === state.selectedKey)) selectRow(rows[0].key);
  }
});
$('tree-filter-clear').addEventListener('click', () => {
  $('tree-filter').value = '';
  state.filter = '';
  $('tree-filter-clear').classList.add('hidden');
  renderTree();
});

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
  commit: () => {
    setView('commit');
    $('commit-message').focus();
  },
  'commit-execute': () => doCommit(false),
  'commit-and-push': () => doCommit(true),
  'commit-history': () => toggleMsgHistory(),
  push: () => doPush(),
  pull: () => doPull(),
  fetch: () => doFetch(),
  branches: () => openBranchPopup(),
  stash: () => openStashDialog(),
  rollback: () => doRollback(),
  save: () => saveCurrent(),
  'open-repo': () => openRepoDialog(),
  refresh: () => refreshStatus(),
  'toggle-panel': () => {
    const panel = $('commit-panel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) treeEl.focus();
  },
  'toggle-log': () => {
    const panel = $('commit-panel');
    if (state.view === 'log' && !panel.classList.contains('hidden')) {
      panel.classList.add('hidden');
    } else {
      panel.classList.remove('hidden');
      setView('log');
    }
  },
  filter: () => {
    $('commit-panel').classList.remove('hidden');
    setView('commit');
    $('tree-filter').focus();
    $('tree-filter').select();
  },
  annotate: () => toggleBlame(),
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

    // Popups and the stash dialog swallow Escape before anything else.
    if (anyPopupOpen()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePopups();
      }
      return;
    }
    if (stashOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeStashDialog();
      }
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
if (window.api.onRepoOpened) window.api.onRepoOpened((repo) => setRepo(repo));

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

$('btn-collapse-unchanged').addEventListener('click', async (e) => {
  await monacoReady;
  const btn = e.currentTarget;
  btn.classList.toggle('active');
  const on = btn.classList.contains('active');
  diffEditor.updateOptions({ hideUnchangedRegions: { enabled: on } });
  window.api.setSettings({ collapseUnchanged: on });
});

$('btn-blame').addEventListener('click', toggleBlame);

// SVG files: flip between the text diff and the rendered image preview.
$('btn-image-view').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  const showImage = !btn.classList.contains('active');
  btn.classList.toggle('active', showImage);
  if (showImage && state.imageDiff) showImageDiff(state.imageDiff);
  else {
    showPane('diff');
    updateDiffCount();
  }
});

// Conflict bar.
$('btn-prev-conflict').addEventListener('click', () => gotoConflict(-1));
$('btn-next-conflict').addEventListener('click', () => gotoConflict(1));
$('btn-all-ours').addEventListener('click', () => acceptAllConflicts('ours'));
$('btn-all-theirs').addEventListener('click', () => acceptAllConflicts('theirs'));
$('btn-mark-resolved').addEventListener('click', markResolved);

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
  if (state.settings.collapseUnchanged) {
    $('btn-collapse-unchanged').classList.add('active');
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
    hideUnchangedRegions: { enabled: !!state.settings.collapseUnchanged },
  });
  try {
    const repo = await window.api.openLastRepo();
    if (repo) await setRepo(repo);
  } catch {
    /* stay on the empty state */
  }
})();
