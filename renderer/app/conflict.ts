'use strict';

/* Merge conflict resolution editor.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

// ----------------------------------------------------- conflict resolution
// Conflicted files open in a single editor over the working-tree file with
// the conflict regions parsed from the markers. Each region gets ours/theirs
// highlighting plus codelens actions (Accept Ours / Theirs / Both), with
// whole-file actions and Mark Resolved in the bar above.

type ConflictSide = 'ours' | 'theirs' | 'both';

let conflictDecorationIds: string[] = [];
let conflictLensEmitter: monaco.Emitter<monaco.languages.CodeLensProvider> | null = null;
let conflictLensProvider: monaco.languages.CodeLensProvider | null = null;
let conflictReparseTimer: ReturnType<typeof setTimeout> | undefined;

function ensureConflictEditor(): void {
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

  monaco.editor.registerCommand('diffier.conflict.ours', (_a, i: number) => acceptConflict(i, 'ours'));
  monaco.editor.registerCommand('diffier.conflict.theirs', (_a, i: number) => acceptConflict(i, 'theirs'));
  monaco.editor.registerCommand('diffier.conflict.both', (_a, i: number) => acceptConflict(i, 'both'));

  conflictLensEmitter = new monaco.Emitter<monaco.languages.CodeLensProvider>();
  conflictLensProvider = {
    onDidChange: conflictLensEmitter.event,
    provideCodeLenses: (model) => {
      if (!state.conflict || model !== conflictModel) return { lenses: [], dispose() {} };
      const { oursLabel, theirsLabel } = state.conflict.info;
      const lenses: monaco.languages.CodeLens[] = [];
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
  };
  monaco.languages.registerCodeLensProvider('*', conflictLensProvider);
}

// <<<<<<< ours [||||||| base] ======= theirs >>>>>>>  (1-based line numbers)
function parseConflictRegions(model: monaco.editor.ITextModel): ConflictRegion[] {
  const regions: ConflictRegion[] = [];
  let cur: ConflictRegion | null = null;
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

function reparseConflicts(): void {
  if (!state.conflict || !conflictModel) return;
  const regions = parseConflictRegions(conflictModel);
  state.conflict.regions = regions;

  const decos: monaco.editor.IModelDeltaDecoration[] = [];
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
  if (conflictLensEmitter && conflictLensProvider) conflictLensEmitter.fire(conflictLensProvider);
  updateConflictCount();
}

function updateConflictCount(): void {
  if (!state.conflict) return;
  const n = state.conflict.regions.length;
  const line = conflictEditor ? (conflictEditor.getPosition()?.lineNumber ?? 0) : 0;
  const idx = state.conflict.regions.findIndex((r) => line >= r.start && line <= r.end);
  $('conflict-count').textContent =
    n === 0
      ? 'No conflicts left'
      : idx >= 0
        ? `Conflict ${idx + 1} of ${n}`
        : `${n} conflict${n === 1 ? '' : 's'}`;
  // Mark Resolved stays enabled even with regions left: markResolved()
  // confirms first, and marker-lookalike content must not hard-block a file.
  $<HTMLButtonElement>('btn-mark-resolved').disabled = false;
  $<HTMLButtonElement>('btn-all-ours').disabled = n === 0;
  $<HTMLButtonElement>('btn-all-theirs').disabled = n === 0;
  $<HTMLButtonElement>('btn-prev-conflict').disabled = n === 0;
  $<HTMLButtonElement>('btn-next-conflict').disabled = n === 0;
}

function conflictRegionText(r: ConflictRegion, which: ConflictSide): string[] {
  const lines: string[] = [];
  const push = (from: number, to: number) => {
    for (let i = from; i <= to; i++) lines.push(conflictModel!.getLineContent(i));
  };
  const oursEnd = (r.base || r.sep) - 1;
  if (which === 'ours' || which === 'both') push(r.start + 1, oursEnd);
  if (which === 'theirs' || which === 'both') push(r.sep + 1, r.end - 1);
  return lines;
}

function acceptConflict(i: number, which: ConflictSide): void {
  if (!state.conflict) return;
  const r = state.conflict.regions[i];
  if (!r) return;
  const lines = conflictRegionText(r, which);
  const endCol = conflictModel!.getLineMaxColumn(r.end);
  let range: monaco.Range;
  let text: string;
  if (lines.length) {
    range = new monaco.Range(r.start, 1, r.end, endCol);
    text = lines.join(conflictModel!.getEOL());
  } else if (r.end < conflictModel!.getLineCount()) {
    // Accepted side is empty (e.g. "deleted in ours") — remove the region's
    // lines including the trailing newline, not leaving a blank line behind.
    range = new monaco.Range(r.start, 1, r.end + 1, 1);
    text = '';
  } else if (r.start > 1) {
    range = new monaco.Range(r.start - 1, conflictModel!.getLineMaxColumn(r.start - 1), r.end, endCol);
    text = '';
  } else {
    range = new monaco.Range(r.start, 1, r.end, endCol);
    text = '';
  }
  conflictModel!.pushEditOperations([], [{ range, text }], () => null);
  reparseConflicts();
}

function acceptAllConflicts(which: ConflictSide): void {
  if (!state.conflict) return;
  // Bottom-up so earlier regions keep their line numbers.
  for (let i = state.conflict.regions.length - 1; i >= 0; i--) acceptConflict(i, which);
}

function gotoConflict(delta: number): void {
  if (!state.conflict || !state.conflict.regions.length) return;
  const regions = state.conflict.regions;
  const line = conflictEditor!.getPosition()?.lineNumber ?? 0;
  let target: ConflictRegion;
  if (delta > 0) target = regions.find((r) => r.start > line) || regions[0]!;
  else target = [...regions].reverse().find((r) => r.start < line) || regions[regions.length - 1]!;
  conflictEditor!.setPosition({ lineNumber: target.start, column: 1 });
  conflictEditor!.revealLineInCenterIfOutsideViewport(target.start);
  conflictEditor!.focus();
  updateConflictCount();
}

async function openConflict(file: FileEntry): Promise<void> {
  let info: ConflictInfoResult;
  try {
    info = await window.api.gitConflictInfo(file.path);
  } catch (err) {
    toast('Failed to load conflict: ' + errMsg(err), true);
    return;
  }
  if (state.current !== file) return;
  ensureConflictEditor();
  if (conflictModel) conflictModel.dispose();
  suppressModelEvents = true;
  conflictModel = monaco.editor.createModel(info.worktree, languageFor(file.path, info.worktree));
  conflictEditor!.setModel(conflictModel);
  suppressModelEvents = false;
  conflictDecorationIds = [];
  state.conflict = { path: file.path, info, regions: [] };
  $('btn-all-ours').textContent = `Accept All ${info.oursLabel}`;
  $('btn-all-theirs').textContent = `Accept All ${info.theirsLabel}`;
  showPane('conflict');
  reparseConflicts();
  if (state.conflict.regions.length) {
    const r = state.conflict.regions[0]!;
    conflictEditor!.setPosition({ lineNumber: r.start, column: 1 });
    conflictEditor!.revealLineInCenterIfOutsideViewport(r.start);
  }
  $('diff-count').textContent = '';
}

function closeConflictSession(): void {
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

async function markResolved(): Promise<void> {
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
    toast('Mark resolved failed: ' + errMsg(err), true);
  }
}
