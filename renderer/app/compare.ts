'use strict';

/* Compare tab: diff two arbitrary refs (branches, tags, or raw commit hashes).
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

async function populateCompareRefList(): Promise<void> {
  if (!state.repo) return;
  let br: BranchesResult;
  try {
    br = await window.api.gitBranches();
  } catch {
    return; // autocomplete is best-effort; typed hashes still work without it
  }
  const dl = $('compare-branch-list');
  dl.textContent = '';
  const names = new Set<string>([...br.locals.map((b) => b.name), ...br.remotes]);
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    dl.appendChild(opt);
  }
}

async function runCompare(): Promise<void> {
  if (!state.repo) return;
  const refA = $<HTMLInputElement>('compare-ref-a').value.trim();
  const refB = $<HTMLInputElement>('compare-ref-b').value.trim();
  if (!refA) return;
  const gen = ++state.compare.gen;
  state.compare.refA = refA;
  state.compare.refB = refB;
  state.compare.collapsed = new Set();
  let files: CommitFile[];
  try {
    files = await window.api.gitCompareRefs(refA, refB || null);
  } catch (err) {
    toast('Compare failed: ' + errMsg(err), true);
    return;
  }
  if (gen !== state.compare.gen) return; // superseded by a later runCompare()
  state.compare.files = files;
  renderCompareFileTree();
  const first = state.compare.files[0];
  if (first) {
    selectCompareFileRow(first.path);
    openRefDiff(refA, refB || 'WORKTREE', first, compareLabel());
  }
}

// Re-runs the current comparison in place (e.g. after commit/pull/push change
// the working tree or a compared branch) without disturbing the ref inputs.
async function refreshCompare(): Promise<void> {
  if (state.view !== 'compare' || !state.compare.refA) return;
  await runCompare();
}

function compareLabel(): string {
  return ` ${state.compare.refA} → ${state.compare.refB || 'Working Tree'}`;
}

function renderCompareFileTree(): void {
  const tree = buildTree(state.compare.files);
  const rows: TreeRow<CommitFile>[] = [];
  flattenRows(tree, 0, '', rows, state.compare.collapsed);
  state.compare.rows = rows;
  const filesEl = $('compare-files');
  filesEl.textContent = '';
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-msg';
    empty.textContent = state.compare.refA ? 'No differences' : 'Pick two refs to compare';
    filesEl.appendChild(empty);
    return;
  }
  for (const row of rows) filesEl.appendChild(buildCompareRowEl(row));
}

function buildCompareRowEl(row: TreeRow<CommitFile>): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tree-row';
  el.dataset.key = row.key;
  el.style.paddingLeft = 6 + (row.depth + 1) * 14 + 'px';

  const chev = document.createElement('span');
  chev.className = 'tree-chevron';

  if (row.kind === 'dir') {
    chev.textContent = state.compare.collapsed.has(row.key) ? '▸' : '▾';
    el.appendChild(chev);

    const name = document.createElement('span');
    name.className = 'dir-name file-name';
    name.textContent = row.node.name;
    el.appendChild(name);

    const count = document.createElement('span');
    count.className = 'dir-count';
    count.textContent = String(countFiles(row.node));
    el.appendChild(count);

    el.addEventListener('click', () => {
      if (state.compare.collapsed.has(row.key)) state.compare.collapsed.delete(row.key);
      else state.compare.collapsed.add(row.key);
      renderCompareFileTree();
    });
  } else {
    el.appendChild(chev);
    el.dataset.path = row.file.path;
    if (state.readOnlyDiff && row.file.path === state.readOnlyDiff.path) el.classList.add('selected');

    appendFileLabel(el, row.file);

    el.addEventListener('click', () => {
      selectCompareFileRow(row.file.path);
      openRefDiff(state.compare.refA, state.compare.refB || 'WORKTREE', row.file, compareLabel());
    });
  }
  return el;
}

function selectCompareFileRow(path: string): void {
  for (const el of $('compare-files').querySelectorAll('.tree-row')) {
    const match = (el as HTMLElement).dataset.path === path;
    el.classList.toggle('selected', match);
    if (match) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
  }
}

// F7-style next/prev file within the Compare tab (mirrors selectCommitFileByOffset).
function selectCompareFileByOffset(delta: number, revealEnd?: boolean): boolean {
  const rows = state.compare.rows.filter((r): r is TreeFileRow<CommitFile> => r.kind === 'file');
  if (!rows.length) return false;
  let idx = rows.findIndex((r) => state.readOnlyDiff && r.file.path === state.readOnlyDiff.path);
  if (idx === -1) idx = delta > 0 ? -1 : 0;
  const next = idx + delta;
  if (next < 0 || next >= rows.length) return false;
  const f = rows[next]!.file;
  selectCompareFileRow(f.path);
  openRefDiff(state.compare.refA, state.compare.refB || 'WORKTREE', f, compareLabel(), revealEnd);
  return true;
}

$('compare-btn').addEventListener('click', runCompare);
for (const id of ['compare-ref-a', 'compare-ref-b']) {
  $(id).addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') runCompare();
  });
}
