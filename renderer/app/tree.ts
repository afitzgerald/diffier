'use strict';

/* Changes tree: model, windowed rendering, selection, filter box.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

// ------------------------------------------------------------- tree model

// Build an IntelliJ-style tree: directories first, single-child directory
// chains compressed into one node ("src/main/java").
function buildTree(files: FileEntry[]): TreeNode {
  const root: TreeNode = { name: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      if (!node.dirs.has(seg)) node.dirs.set(seg, { name: seg, dirs: new Map(), files: [] });
      node = node.dirs.get(seg)!;
    }
    node.files.push(f);
  }

  function compress(node: TreeNode): void {
    for (const [key, child] of [...node.dirs]) {
      let c = child;
      while (c.dirs.size === 1 && c.files.length === 0) {
        const [[, gchild]] = [...c.dirs];
        c = { name: c.name + '/' + gchild!.name, dirs: gchild!.dirs, files: gchild!.files };
      }
      node.dirs.set(key, c);
      compress(c);
    }
  }
  compress(root);
  return root;
}

function countFiles(node: TreeNode): number {
  let n = node.files.length;
  for (const child of node.dirs.values()) n += countFiles(child);
  return n;
}

function collectFiles(node: TreeNode, out: FileEntry[] = []): FileEntry[] {
  for (const child of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    collectFiles(child, out);
  }
  for (const f of node.files) out.push(f);
  return out;
}

function flattenRows(node: TreeNode, depth: number, prefix: string, out: TreeRow[]): void {
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

const TYPE_ICON: Record<ChangeType, string> = {
  MODIFIED: '●',
  ADDED: '＋',
  DELETED: '－',
  UNVERSIONED: '？',
  CONFLICT: '⚠',
  MOVED: '➜',
};

// Append the colored type icon + name for a changed file to a row element —
// the one place the icon/label/rename-arrow presentation lives (used by the
// changes tree and the Log tab's file list).
function appendFileLabel(
  row: HTMLElement,
  file: { path: string; origPath: string | null; type: ChangeType },
  opts: { fullPath?: boolean } = {}
): HTMLElement {
  const icon = document.createElement('span');
  icon.className = 'tree-icon file-name ' + file.type;
  icon.textContent = TYPE_ICON[file.type] || '●';
  row.appendChild(icon);

  const name = document.createElement('span');
  name.className = 'file-name ' + file.type;
  name.textContent = opts.fullPath ? file.path : file.path.split('/').pop()!;
  name.title = file.origPath ? `${file.origPath} → ${file.path}` : file.path;
  row.appendChild(name);
  return name;
}

// Files surviving the filter box (checkbox state always tracks all files).
function visibleFiles(): FileEntry[] {
  if (!state.filter) return state.files;
  const q = state.filter.toLowerCase();
  return state.files.filter((f) => f.path.toLowerCase().includes(q));
}

const TREE_ROW_H = 22;
const TREE_OVERSCAN = 8;

function buildRowEl(row: TreeRow): HTMLElement {
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

    appendFileLabel(el, row.file);

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

function renderTree(): void {
  const files = visibleFiles();
  const tree = buildTree(files);
  const rows: TreeRow[] = [];
  flattenRows(tree, 0, '', rows);
  state.rows = rows;
  renderTreeWindow(files);
  updateCommitCount();
}

// Windowed rendering: only the rows in (and around) the viewport get DOM
// nodes, so repositories with thousands of changed files stay responsive.
function renderTreeWindow(files?: FileEntry[]): void {
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
  for (let i = first; i < last; i++) treeEl.appendChild(buildRowEl(rows[i]!));
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

function toggleCollapse(key: string): void {
  if (state.collapsed.has(key)) state.collapsed.delete(key);
  else state.collapsed.add(key);
  renderTree();
}

function toggleChecked(path: string): void {
  if (state.checked.has(path)) state.checked.delete(path);
  else state.checked.add(path);
  renderTree();
}

function updateCommitCount(): void {
  const n = state.checked.size;
  const { partials, skipped } = commitSelection();
  let text = state.files.length ? `${n} of ${state.files.length} selected` : '';
  if (partials.length) text += `, ${partials.length} partial`;
  if (skipped.length) text += `, ${skipped.length} empty`;
  $('commit-count').textContent = text;
  const committable = n - skipped.length;
  $<HTMLButtonElement>('btn-commit').disabled = committable <= 0;
  $<HTMLButtonElement>('btn-commit-push').disabled = committable <= 0;
}

// ---------------------------------------------------------- row selection

function fileRows(): TreeFileRow[] {
  return state.rows.filter((r): r is TreeFileRow => r.kind === 'file');
}

function selectedRow(): TreeRow | null {
  return state.rows.find((r) => r.key === state.selectedKey) || null;
}

function selectRow(key: string, revealEnd?: boolean): void {
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

function moveSelection(delta: number): void {
  if (!state.rows.length) return;
  const idx = state.rows.findIndex((r) => r.key === state.selectedKey);
  const next = Math.min(state.rows.length - 1, Math.max(0, idx + delta));
  selectRow(state.rows[next]!.key);
}

function selectFileByOffset(delta: number, revealEnd?: boolean): boolean {
  const rows = fileRows();
  if (!rows.length) return false;
  let idx = rows.findIndex((r) => state.current && r.file.path === state.current.path);
  if (idx === -1) idx = delta > 0 ? -1 : 0;
  const next = idx + delta;
  if (next < 0 || next >= rows.length) return false;
  selectRow(rows[next]!.key, revealEnd);
  return true;
}

// ------------------------------------------------------------- tree filter

$<HTMLInputElement>('tree-filter').addEventListener('input', () => {
  state.filter = $<HTMLInputElement>('tree-filter').value.trim();
  $('tree-filter-clear').classList.toggle('hidden', !state.filter);
  renderTree();
});
$('tree-filter').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if ($<HTMLInputElement>('tree-filter').value) {
      $<HTMLInputElement>('tree-filter').value = '';
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
    if (rows.length && !rows.some((r) => r.key === state.selectedKey)) selectRow(rows[0]!.key);
  }
});
$('tree-filter-clear').addEventListener('click', () => {
  $<HTMLInputElement>('tree-filter').value = '';
  state.filter = '';
  $('tree-filter-clear').classList.add('hidden');
  renderTree();
});
