'use strict';

/* IntelliJ F7-style difference navigation.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

// -------------------------------------------------------- diff navigation

function changeStartLine(c: monaco.editor.ILineChange): number {
  // For pure deletions modifiedEndLineNumber is 0 and the change anchors
  // after modifiedStartLineNumber — which for a deletion at EOF would point
  // past the last line, so clamp to the model.
  const line = c.modifiedEndLineNumber > 0 ? c.modifiedStartLineNumber : c.modifiedStartLineNumber + 1;
  const model = diffEditor && diffEditor.getModifiedEditor().getModel();
  const max = model ? model.getLineCount() : Infinity;
  return Math.max(1, Math.min(line, max));
}

function gotoChange(c: monaco.editor.ILineChange): void {
  const line = changeStartLine(c);
  const ed = diffEditor!.getModifiedEditor();
  ed.setPosition({ lineNumber: line, column: 1 });
  ed.revealLineInCenterIfOutsideViewport(line, monaco.editor.ScrollType.Smooth);
  ed.focus();
}

// IntelliJ F7 flow: step through differences; at the last one, a hint arms a
// second F7 press to jump to the first difference of the next file.
// Worktree tree nav and commit-file-list nav both walk "the next file" —
// which list depends on which diff pane mode is active (see paneMode()).
function selectNextFile(revealEnd?: boolean): boolean {
  if (state.view === 'compare') return selectCompareFileByOffset(1, revealEnd);
  return state.readOnlyDiff ? selectCommitFileByOffset(1, revealEnd) : selectFileByOffset(1, revealEnd);
}
function selectPrevFile(revealEnd?: boolean): boolean {
  if (state.view === 'compare') return selectCompareFileByOffset(-1, revealEnd);
  return state.readOnlyDiff ? selectCommitFileByOffset(-1, revealEnd) : selectFileByOffset(-1, revealEnd);
}

// ------------------------------------------------------ markdown diff view

// The unified markdown view has no editor to anchor a cursor to, so position
// is tracked explicitly by index rather than derived from scrollTop — a
// centered block near either edge of the document clamps the scroll to
// where it already was, and deriving "current" from scrollTop would then
// re-find that same block forever instead of advancing.
function markdownChangeBlocks(): HTMLElement[] {
  return Array.from($('md-diff-body').querySelectorAll<HTMLElement>('.md-added, .md-removed'));
}

let mdChangeIndex = -1;

// Called whenever the markdown diff is (re)rendered, so navigation starts
// fresh instead of pointing at a block index from a previous file.
function resetMdChangeNav(): void {
  mdChangeIndex = -1;
}

function gotoMdBlock(b: HTMLElement): void {
  b.scrollIntoView({ block: 'center', behavior: 'auto' });
}

function nextMarkdownChange(): void {
  const blocks = markdownChangeBlocks();
  if (!blocks.length) return void toast('No changes');
  if (mdChangeIndex >= blocks.length - 1) return void toast('No more changes');
  gotoMdBlock(blocks[++mdChangeIndex]!);
}

function prevMarkdownChange(): void {
  const blocks = markdownChangeBlocks();
  if (!blocks.length) return void toast('No changes');
  if (mdChangeIndex <= 0) return void toast('No more changes');
  gotoMdBlock(blocks[--mdChangeIndex]!);
}

// Recompute the ruler marks after (re)rendering the markdown diff, and on
// any resize/zoom that changes the scroll height (ResizeObserver, wired in
// boot.ts, covers both).
function updateMdDiffRuler(): void {
  const ruler = $('md-diff-ruler');
  ruler.textContent = '';
  const body = $('md-diff-body');
  const total = body.scrollHeight;
  if (!total) return;
  const rulerHeight = ruler.clientHeight;
  for (const b of markdownChangeBlocks()) {
    const mark = document.createElement('div');
    mark.className = 'md-diff-ruler-mark ' + (b.classList.contains('md-added') ? 'md-added' : 'md-removed');
    mark.style.top = `${(b.offsetTop / total) * rulerHeight}px`;
    mark.style.height = `${Math.max(2, (b.offsetHeight / total) * rulerHeight)}px`;
    mark.addEventListener('click', () => gotoMdBlock(b));
    ruler.appendChild(mark);
  }
}

function nextDifference(): void {
  if (!$('markdown-diff').classList.contains('hidden')) {
    nextMarkdownChange();
    return;
  }
  if (!state.current && !state.readOnlyDiff) {
    selectNextFile();
    return;
  }
  const changes = getLineChanges();
  const line = diffEditor!.getModifiedEditor().getPosition()?.lineNumber || 0;
  const next = changes.find((c) => changeStartLine(c) > line);
  state.shiftF7Armed = false;
  if (next) {
    state.f7Armed = false;
    gotoChange(next);
  } else if (state.f7Armed || changes.length === 0) {
    state.f7Armed = false;
    if (!selectNextFile()) toast('No more changed files');
  } else {
    state.f7Armed = true;
    toast(`Press ${actionShortcut('next-diff')} to go to the next file`);
  }
}

function prevDifference(): void {
  if (!$('markdown-diff').classList.contains('hidden')) {
    prevMarkdownChange();
    return;
  }
  if (!state.current && !state.readOnlyDiff) {
    selectPrevFile(true);
    return;
  }
  const changes = getLineChanges();
  const line = diffEditor!.getModifiedEditor().getPosition()?.lineNumber || Infinity;
  const prev = [...changes].reverse().find((c) => changeStartLine(c) < line);
  state.f7Armed = false;
  if (prev) {
    state.shiftF7Armed = false;
    gotoChange(prev);
  } else if (state.shiftF7Armed || changes.length === 0) {
    state.shiftF7Armed = false;
    if (!selectPrevFile(true)) toast('No more changed files');
  } else {
    state.shiftF7Armed = true;
    toast(`Press ${actionShortcut('prev-diff')} to go to the previous file`);
  }
}
