'use strict';

/* Log tab: lane graph, commit details, file history.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

// --------------------------------------------------------------- log view

const LOG_PAGE = 200;
const LANE_W = 10;
const LOG_ROW_H = 24;
const LANE_COLORS = ['#3574f0', '#73bd79', '#ed7261', '#d9a343', '#43b9c9', '#b07fe8', '#f75464'];

function setView(view: 'commit' | 'log' | 'compare'): void {
  state.view = view;
  $('commit-view').classList.toggle('hidden', view !== 'commit');
  $('log-view').classList.toggle('hidden', view !== 'log');
  $('compare-view').classList.toggle('hidden', view !== 'compare');
  $('tab-commit').classList.toggle('active', view === 'commit');
  $('tab-log').classList.toggle('active', view === 'log');
  $('tab-compare').classList.toggle('active', view === 'compare');
  // Rollback acts on the commit tab's worktree tree selection — meaningless
  // (and misleading) while Log or Compare is showing a different file list.
  // Expand/Collapse All apply per-view (see boot.ts) so they stay visible.
  $('btn-rollback').classList.toggle('hidden', view !== 'commit');
  if (view === 'log') {
    if (!state.log.entries.length) loadLog(true);
    $('log-list').focus();
  } else if (view === 'compare') {
    populateCompareRefList();
    $('compare-ref-a').focus();
  } else {
    treeEl.focus();
  }
}

// Reset the log model (entries, lane state, selection) for a fresh load.
// `filePath` non-null enters file-history mode.
function resetLog(filePath: string | null): void {
  state.log.gen = (state.log.gen || 0) + 1; // discard in-flight page loads
  state.log.entries = [];
  state.log.graphLanes = [];
  state.log.done = false;
  state.log.loading = false;
  state.log.selected = null;
  state.log.filePath = filePath || null;
  state.log.details = null;
  state.log.collapsed = new Set();
  state.log.rows = [];
  state.log.marked = new Set();
  $('log-details').classList.add('hidden');
}

async function loadLog(reset?: boolean): Promise<void> {
  if (!state.repo) return;
  if (!reset && state.log.loading) return;
  if (reset) resetLog(state.log.filePath);
  const gen = state.log.gen || 0;
  state.log.loading = true;
  if (reset) renderLog();
  try {
    const batch: LogEntryWithGraph[] = await window.api.gitLog({
      skip: state.log.entries.length,
      limit: LOG_PAGE,
      path: state.log.filePath,
    });
    if (gen !== (state.log.gen || 0)) return; // superseded by a reset
    if (batch.length < LOG_PAGE) state.log.done = true;
    // A followed file history is a sparse slice of the DAG — parents mostly
    // aren't in the list, so lanes would never close. Skip the graph there.
    // The layout is a pure left-to-right fold, so pages resume from the
    // saved lane state instead of recomputing all prior entries.
    if (!state.log.filePath) {
      state.log.graphLanes = computeLogGraph(batch, state.log.graphLanes);
    }
    state.log.entries.push(...batch);
    if (reset) renderLog();
    else appendLogRows(batch);
  } catch (err) {
    toast('git log failed: ' + errMsg(err), true);
  } finally {
    if (gen === (state.log.gen || 0)) {
      state.log.loading = false;
      syncMoreRow();
    }
  }
}

// Lane assignment for the commit graph: each lane tracks the hash it expects
// next. A commit takes over the lane expecting it (or a free one), its first
// parent continues the lane, other lanes expecting it merge in, extra parents
// fork out to new lanes.
function computeLogGraph(entries: LogEntryWithGraph[], lanes: (string | null)[] = []): (string | null)[] {
  lanes = lanes.slice();
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
    const merging: number[] = [];
    lanes.forEach((h, i) => {
      if (h === c.hash && i !== col) {
        merging.push(i);
        lanes[i] = null;
      }
    });
    const forks: number[] = [];
    if (!c.parents.length) {
      lanes[col] = null;
    } else {
      lanes[col] = c.parents[0]!;
      for (let pi = 1; pi < c.parents.length; pi++) {
        const p = c.parents[pi]!;
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
  return lanes;
}

function laneColor(i: number): string {
  return LANE_COLORS[i % LANE_COLORS.length]!;
}

function logGraphSvg(c: LogEntryWithGraph): string {
  const g = c.graph!;
  const width = Math.max(g.before.length, g.after.length, g.col + 1) * LANE_W;
  const x = (i: number) => i * LANE_W + LANE_W / 2;
  const mid = LOG_ROW_H / 2;
  const parts: string[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number, color: string) =>
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

function relTime(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400 * 2) return Math.round(s / 3600) + 'h';
  if (s < 86400 * 30) return Math.round(s / 86400) + 'd';
  return new Date(ts).toISOString().slice(0, 10);
}

function buildLogRow(c: LogEntryWithGraph): HTMLElement {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.dataset.hash = c.hash;
  if (c.hash === state.log.selected) row.classList.add('selected');
  if (state.log.marked.has(c.hash)) row.classList.add('marked');

  if (!state.log.filePath && c.graph) {
    const graph = document.createElement('span');
    graph.innerHTML = logGraphSvg(c);
    row.appendChild(graph.firstChild!);
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

  row.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey) toggleLogMark(c.hash);
    else selectLogEntry(c);
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openLogContextMenu(e, c.hash);
  });
  return row;
}

// Ctrl/Cmd-click marks a commit for comparison; capped at 2 (oldest mark
// dropped), mirroring VCS-graph tools' "select two, then compare" gesture.
function toggleLogMark(hash: string): void {
  if (state.log.marked.has(hash)) {
    state.log.marked.delete(hash);
  } else {
    state.log.marked.add(hash);
    while (state.log.marked.size > 2) state.log.marked.delete(state.log.marked.values().next().value!);
  }
  for (const el of $('log-list').querySelectorAll('.log-row')) {
    (el as HTMLElement).classList.toggle('marked', state.log.marked.has((el as HTMLElement).dataset.hash!));
  }
}

function openLogContextMenu(e: MouseEvent, hash: string): void {
  const marked = new Set(state.log.marked);
  if (marked.size < 2) marked.add(hash);
  const menu = $('context-menu');
  menu.textContent = '';
  if (marked.size === 2) {
    const [a, b] = [...marked];
    menu.appendChild(
      popupItem('Compare Selected Commits', { icon: '⇄', onClick: () => compareLogCommits(a!, b!) })
    );
  } else {
    menu.appendChild(popupItem('Ctrl/Cmd-click another commit to compare', { section: true }));
  }
  menu.classList.remove('hidden');
  menu.style.right = menu.style.bottom = 'auto';
  menu.style.left = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8) + 'px';
}

// Diffs oldest -> newest (by position in the currently loaded log) so the
// comparison reads as "what changed going from A to B", not reverse.
function compareLogCommits(hashA: string, hashB: string): void {
  const idxA = state.log.entries.findIndex((c) => c.hash === hashA);
  const idxB = state.log.entries.findIndex((c) => c.hash === hashB);
  const [older, newer] = idxA > idxB ? [hashA, hashB] : [hashB, hashA];
  state.log.marked.clear();
  setView('compare');
  $<HTMLInputElement>('compare-ref-a').value = older;
  $<HTMLInputElement>('compare-ref-b').value = newer;
  runCompare();
}

// Keep exactly one trailing "Load more" row, reflecting done/loading state.
function syncMoreRow(): void {
  const list = $('log-list');
  const existing = list.querySelector('.log-more');
  if (existing) existing.remove();
  if (state.log.done) return;
  const more = document.createElement('div');
  more.className = 'log-more';
  more.textContent = state.log.loading ? 'Loading…' : 'Load more…';
  more.addEventListener('click', () => loadLog(false));
  list.appendChild(more);
}

// Append rows for one page without rebuilding earlier rows (the list is
// append-only between resets).
function appendLogRows(batch: LogEntryWithGraph[]): void {
  const list = $('log-list');
  const frag = document.createDocumentFragment();
  for (const c of batch) frag.appendChild(buildLogRow(c));
  const more = list.querySelector('.log-more');
  if (more) more.remove();
  list.appendChild(frag);
  syncMoreRow();
}

// Full rebuild — used on reset; pagination goes through appendLogRows.
function renderLog(): void {
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

  appendLogRows(state.log.entries);
}

interface ParsedRef {
  name: string;
  head: boolean;
}

function parseRefs(refs: string): ParsedRef[] {
  if (!refs) return [];
  return refs
    .split(', ')
    .map((r): ParsedRef => {
      if (r.startsWith('HEAD -> ')) return { name: r.slice(8), head: true };
      if (r === 'HEAD') return { name: 'HEAD', head: true };
      if (r.startsWith('tag: ')) return { name: '🏷 ' + r.slice(5), head: false };
      return { name: r, head: false };
    })
    .slice(0, 3);
}

async function selectLogEntry(c: LogEntryWithGraph): Promise<void> {
  state.log.selected = c.hash;
  for (const el of $('log-list').querySelectorAll('.log-row')) {
    el.classList.toggle('selected', (el as HTMLElement).dataset.hash === c.hash);
  }
  let det: CommitDetails;
  try {
    det = await window.api.gitCommitDetails(c.hash);
  } catch (err) {
    toast('Failed to load commit: ' + errMsg(err), true);
    return;
  }
  if (state.log.selected !== c.hash) return;
  state.log.collapsed = new Set();
  renderLogDetails(det);
  // In file-history mode jump straight to this file's diff at that commit.
  // Older commits may know the file under a pre-rename path — only auto-open
  // when the commit actually touched the path we're following; the details
  // list still shows everything the commit changed.
  if (state.log.filePath) {
    const f =
      det.files.find((x) => x.path === state.log.filePath) ||
      det.files.find((x) => x.origPath === state.log.filePath);
    if (f) {
      selectCommitFileRow(f.path);
      openCommitFileDiff(det, f);
    }
  } else if (det.files.length) {
    const f = det.files[0]!;
    selectCommitFileRow(f.path);
    openCommitFileDiff(det, f);
  }
}

function renderLogDetails(det: CommitDetails): void {
  state.log.details = det;
  $('log-details').classList.remove('hidden');
  $('log-details-header').textContent = det.message;
  $('log-details-meta').textContent =
    `${det.short} · ${det.author} <${det.email}> · ${new Date(det.time).toLocaleString()}` +
    (det.parents.length > 1 ? ' · merge' : '');
  renderCommitFileTree(det);
}

// Same IntelliJ-style directory-grouped tree as the worktree changes list
// (buildTree/flattenRows from tree.ts), rendered with its own collapse state
// since a commit's directories aren't the worktree's.
function renderCommitFileTree(det: CommitDetails): void {
  const tree = buildTree(det.files);
  const rows: TreeRow<CommitFile>[] = [];
  flattenRows(tree, 0, '', rows, state.log.collapsed);
  state.log.rows = rows;
  const filesEl = $('log-details-files');
  filesEl.textContent = '';
  for (const row of rows) filesEl.appendChild(buildCommitRowEl(row, det));
}

function buildCommitRowEl(row: TreeRow<CommitFile>, det: CommitDetails): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tree-row';
  el.dataset.key = row.key;
  el.style.paddingLeft = 6 + (row.depth + 1) * 14 + 'px';

  const chev = document.createElement('span');
  chev.className = 'tree-chevron';

  if (row.kind === 'dir') {
    chev.textContent = state.log.collapsed.has(row.key) ? '▸' : '▾';
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
      if (state.log.collapsed.has(row.key)) state.log.collapsed.delete(row.key);
      else state.log.collapsed.add(row.key);
      renderCommitFileTree(det);
    });
  } else {
    el.appendChild(chev);
    el.dataset.path = row.file.path;
    if (state.readOnlyDiff && row.file.path === state.readOnlyDiff.path) el.classList.add('selected');

    appendFileLabel(el, row.file);

    el.addEventListener('click', () => {
      selectCommitFileRow(row.file.path);
      openCommitFileDiff(det, row.file);
    });
  }
  return el;
}

function selectCommitFileRow(path: string): void {
  for (const el of $('log-details-files').querySelectorAll('.tree-row')) {
    const match = (el as HTMLElement).dataset.path === path;
    el.classList.toggle('selected', match);
    if (match) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
  }
}

// F7-style next/prev file within the currently shown commit (mirrors
// selectFileByOffset for the worktree tree).
function selectCommitFileByOffset(delta: number, revealEnd?: boolean): boolean {
  const det = state.log.details;
  if (!det) return false;
  const rows = state.log.rows.filter((r): r is TreeFileRow<CommitFile> => r.kind === 'file');
  if (!rows.length) return false;
  let idx = rows.findIndex((r) => state.readOnlyDiff && r.file.path === state.readOnlyDiff.path);
  if (idx === -1) idx = delta > 0 ? -1 : 0;
  const next = idx + delta;
  if (next < 0 || next >= rows.length) return false;
  const f = rows[next]!.file;
  selectCommitFileRow(f.path);
  openCommitFileDiff(det, f, revealEnd);
  return true;
}

function showFileHistory(path: string): void {
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
$('tab-compare').addEventListener('click', () => setView('compare'));
