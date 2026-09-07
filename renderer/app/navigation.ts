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
  // Keep mdChangeIndex in sync so a ruler click, which passes the block
  // directly rather than an index, doesn't leave next/prevMarkdownChange
  // resuming from wherever navigation last left off.
  const idx = markdownChangeBlocks().indexOf(b);
  if (idx !== -1) mdChangeIndex = idx;
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

// ------------------------------------------------------ markdown find

/* Find-in-document for the rendered markdown pane — the one view with no
   editor, so Monaco's own find widget can't serve it. Matches are painted
   with the CSS Custom Highlight API (Ranges, no DOM mutation), so the
   rendered document and its diff tinting stay exactly as rendered and
   clearing is one delete() per highlight. */

let mdFindMatches: Range[] = [];
let mdFindIndex = -1;

function mdFindOpen(): boolean {
  return !$('md-find-bar').classList.contains('hidden');
}

function openMdFind(): void {
  $('md-find-bar').classList.remove('hidden');
  const input = $<HTMLInputElement>('md-find-input');
  input.focus();
  input.select();
  runMdFind(true);
}

function closeMdFind(): void {
  $('md-find-bar').classList.add('hidden');
  mdFindMatches = [];
  mdFindIndex = -1;
  CSS.highlights.delete('md-find');
  CSS.highlights.delete('md-find-current');
}

// ponytail: plain case-insensitive substring, matched inside one text node —
// a query straddling an inline element edge ("**bo**ld") won't hit. Search a
// concatenation of the pane with an offset map if that ever matters.
function runMdFind(keepIndex?: boolean): void {
  const q = $<HTMLInputElement>('md-find-input').value.toLowerCase();
  const prev = mdFindIndex;
  mdFindMatches = [];
  if (q) {
    const walk = document.createTreeWalker($('md-diff-body'), NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const text = (n.nodeValue || '').toLowerCase();
      for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + q.length)) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + q.length);
        mdFindMatches.push(r);
      }
    }
  }
  const wanted = keepIndex && prev > 0 ? prev : 0;
  mdFindIndex = mdFindMatches.length ? Math.min(wanted, mdFindMatches.length - 1) : -1;
  paintMdFind();
}

function paintMdFind(): void {
  const current = mdFindIndex >= 0 ? mdFindMatches[mdFindIndex]! : null;
  CSS.highlights.set('md-find', new Highlight(...mdFindMatches.filter((r) => r !== current)));
  CSS.highlights.set('md-find-current', new Highlight(...(current ? [current] : [])));
  $('md-find-count').textContent = mdFindMatches.length
    ? `${mdFindIndex + 1}/${mdFindMatches.length}`
    : $<HTMLInputElement>('md-find-input').value
      ? 'No matches'
      : '';
  // Ranges have no scrollIntoView of their own; the containing element is
  // close enough at markdown block sizes.
  if (current) current.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'auto' });
}

function stepMdFind(delta: number): void {
  if (!mdFindMatches.length) return;
  mdFindIndex = (mdFindIndex + delta + mdFindMatches.length) % mdFindMatches.length;
  paintMdFind();
}

// The pane re-renders on a mode switch, a file switch and every edit — the
// old Ranges then point at nodes that are gone, so re-find from scratch.
function refreshMdFind(): void {
  if (mdFindOpen()) runMdFind(true);
}

// ⌘F: the markdown pane gets our bar, every editor view gets Monaco's own
// find widget (the global keydown handler swallows the key before Monaco
// would see it, so hand it over explicitly).
function findInView(): void {
  if (!$('markdown-diff').classList.contains('hidden')) return openMdFind();
  const ed: monaco.editor.ICodeEditor | null =
    state.conflict && conflictEditor ? conflictEditor : diffEditor ? diffEditor.getModifiedEditor() : null;
  if (!ed) return void toast('Nothing to search');
  ed.focus();
  void ed.getAction('actions.find')?.run();
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
