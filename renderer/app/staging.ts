'use strict';

/* Partial (per-hunk) staging: gutter checkboxes and commit selection.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

// -------------------------------------------------------- partial staging
// Each diff hunk in the modified editor gets a gutter checkbox. Unchecked
// hunks are excluded from the next commit: the renderer builds the exact file
// content to commit (original text + checked hunks) and the main process
// records it through a temporary index.

function hunkKey(c: monaco.editor.ILineChange): string {
  return `${c.originalStartLineNumber}:${c.originalEndLineNumber}`;
}

// Partial staging only makes sense for a plain modified worktree file whose
// text diff is currently in the editor.
function hunkStagingActive(): boolean {
  return !!(
    paneMode() === 'worktree' &&
    state.current!.type === 'MODIFIED' &&
    !state.current!.origPath &&
    // git forbids per-hunk commits while a merge/cherry-pick concludes.
    !state.merging &&
    originalModel &&
    modifiedModel &&
    // A diff update for the previous file can fire after state.current moved
    // on; without this the wrong file's hunks would be (re)attributed.
    currentModelsPath === state.current!.path
  );
}

let hunkDecorationIds: string[] = [];

function updateHunkDecorations(): void {
  if (!diffEditor) return;
  const ed = diffEditor.getModifiedEditor();
  if (!hunkStagingActive()) {
    hunkDecorationIds = ed.deltaDecorations(hunkDecorationIds, []);
    return;
  }
  const changes = getLineChanges();
  const p = state.current!.path;
  let entry = state.hunks.get(p);
  if (entry) {
    // Drop exclusions for hunks that no longer exist (file edited/reloaded).
    const valid = new Set(changes.map(hunkKey));
    for (const k of [...entry.excluded]) if (!valid.has(k)) entry.excluded.delete(k);
    if (!entry.excluded.size) {
      state.hunks.delete(p);
      entry = undefined;
    }
  }
  const excluded = entry ? entry.excluded : new Set<string>();
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
    // Rebuilding the prepared content walks the whole file, and Monaco
    // recomputes the diff per keystroke (main thread) — debounce so typing
    // in a large partially-staged file doesn't churn whole-file strings.
    clearTimeout(entry.rebuildTimer);
    entry.rebuildTimer = setTimeout(() => rebuildPartialEntry(p), 250);
  }
  updateCommitCount();
}

// Prepare (or refresh) the exact content a partial commit would record,
// plus the snapshots commitWithPartials verifies against at commit time.
function rebuildPartialEntry(path: string): void {
  const entry = state.hunks.get(path);
  if (!entry || !hunkStagingActive() || state.current!.path !== path) return;
  entry.content = buildPartialContent(getLineChanges(), entry.excluded);
  entry.snapshotModified = modifiedModel!.getValue();
  entry.snapshotOriginal = originalModel!.getValue();
}

// Run any pending debounced rebuild immediately — called before committing
// so a commit right after typing doesn't record stale prepared content.
function flushPartialRebuild(): void {
  for (const [path, entry] of state.hunks) {
    if (entry.rebuildTimer === undefined) continue;
    clearTimeout(entry.rebuildTimer);
    entry.rebuildTimer = undefined;
    rebuildPartialEntry(path);
  }
}

function toggleHunk(c: monaco.editor.ILineChange): void {
  if (!hunkStagingActive()) return;
  const p = state.current!.path;
  let entry = state.hunks.get(p);
  if (!entry) {
    entry = { excluded: new Set(), total: 0, content: '' };
    state.hunks.set(p, entry);
  }
  const k = hunkKey(c);
  if (entry.excluded.has(k)) entry.excluded.delete(k);
  else entry.excluded.add(k);
  updateHunkDecorations();
  rebuildPartialEntry(p); // immediate — a commit may follow right away
}

// Original content with only the checked hunks applied.
function buildPartialContent(changes: monaco.editor.ILineChange[], excluded: Set<string>): string {
  const oLines = originalModel!.getLinesContent();
  const mLines = modifiedModel!.getLinesContent();
  const eol = modifiedModel!.getEOL();
  const out: string[] = [];
  let oPos = 1; // 1-based cursor into original lines
  for (const c of changes) {
    const insertion = c.originalEndLineNumber === 0;
    const oStart = insertion ? c.originalStartLineNumber + 1 : c.originalStartLineNumber;
    const oEndEx = insertion ? oStart : c.originalEndLineNumber + 1;
    while (oPos < oStart) out.push(oLines[oPos++ - 1]!);
    if (excluded.has(hunkKey(c))) {
      while (oPos < oEndEx) out.push(oLines[oPos++ - 1]!); // keep original
    } else {
      if (c.modifiedEndLineNumber > 0) {
        for (let m = c.modifiedStartLineNumber; m <= c.modifiedEndLineNumber; m++) {
          out.push(mLines[m - 1]!);
        }
      }
      oPos = oEndEx;
    }
  }
  while (oPos <= oLines.length) out.push(oLines[oPos++ - 1]!);
  return out.join(eol);
}

interface CommitSelection {
  full: FileEntry[];
  partials: PartialCommitFile[];
  skipped: string[];
}

// Split the checked files into full commits, partial (hunk-limited) commits,
// and files whose every hunk is excluded (nothing to commit).
function commitSelection(): CommitSelection {
  const full: FileEntry[] = [];
  const partials: PartialCommitFile[] = [];
  const skipped: string[] = [];
  for (const f of state.files) {
    if (!state.checked.has(f.path)) continue;
    const h = state.hunks.get(f.path);
    if (h && h.excluded.size && f.type === 'MODIFIED' && !f.origPath) {
      if (h.excluded.size >= h.total) skipped.push(f.path);
      else {
        partials.push({
          path: f.path,
          content: h.content,
          // The main process refuses the commit if the file or HEAD no
          // longer matches what the selection was prepared against.
          expectedWorktree: h.snapshotModified,
          expectedHead: h.snapshotOriginal,
        });
      }
    } else {
      full.push(f);
    }
  }
  return { full, partials, skipped };
}
