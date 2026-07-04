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
function nextDifference(): void {
  if (!state.current) {
    selectFileByOffset(1);
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
    if (!selectFileByOffset(1)) toast('No more changed files');
  } else {
    state.f7Armed = true;
    toast(`Press ${actionShortcut('next-diff')} to go to the next file`);
  }
}

function prevDifference(): void {
  if (!state.current) {
    selectFileByOffset(-1, true);
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
    if (!selectFileByOffset(-1, true)) toast('No more changed files');
  } else {
    state.shiftF7Armed = true;
    toast(`Press ${actionShortcut('prev-diff')} to go to the previous file`);
  }
}
