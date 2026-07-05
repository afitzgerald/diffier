'use strict';

/* Temporary font-size zoom for the diff/conflict editors and the markdown
   viewer. Session-only (like browser zoom) — lives in state.zoomLevel, not
   Settings, so it resets on restart. Part of the Diffier renderer — classic
   scripts share module scope; load order is defined in index.html. */

const ZOOM_BASE_EDITOR_SIZE = 12;
const ZOOM_BASE_EDITOR_LINE_HEIGHT = 19;
const ZOOM_BASE_MD_SIZE = 13;
const ZOOM_MIN = -4;
const ZOOM_MAX = 12;

function zoomedEditorFontOptions(): { fontSize: number; lineHeight: number } {
  const fontSize = ZOOM_BASE_EDITOR_SIZE + state.zoomLevel;
  const lineHeight = Math.round(fontSize * (ZOOM_BASE_EDITOR_LINE_HEIGHT / ZOOM_BASE_EDITOR_SIZE));
  return { fontSize, lineHeight };
}

function applyZoom(): void {
  const opts = zoomedEditorFontOptions();
  diffEditor?.updateOptions(opts);
  conflictEditor?.updateOptions(opts);
  document.documentElement.style.setProperty('--md-font-size', `${ZOOM_BASE_MD_SIZE + state.zoomLevel}px`);
}

function zoomIn(): void {
  state.zoomLevel = Math.min(ZOOM_MAX, state.zoomLevel + 1);
  applyZoom();
}

function zoomOut(): void {
  state.zoomLevel = Math.max(ZOOM_MIN, state.zoomLevel - 1);
  applyZoom();
}

function zoomReset(): void {
  state.zoomLevel = 0;
  applyZoom();
}

// Exposed for UI tests: diffEditor is a `let`, not a window property, so
// there's no other way to read its live font size from page.evaluate().
function currentDiffEditorFontSize(): number | null {
  return diffEditor ? diffEditor.getModifiedEditor().getOption(monaco.editor.EditorOption.fontSize) : null;
}
