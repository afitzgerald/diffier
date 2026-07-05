'use strict';

/* Diff pane: worktree diffs, commit diffs, image preview, save/autosave.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

// ------------------------------------------------------------- diff editor

type DiffPaneView = 'diff' | 'conflict' | 'image' | 'markdown';

// Switch the diff pane between its content views.
function showPane(which: DiffPaneView): void {
  $('diff-editor').style.display = which === 'diff' ? '' : 'none';
  $('conflict-editor').classList.toggle('hidden', which !== 'conflict');
  $('image-diff').classList.toggle('hidden', which !== 'image');
  $('markdown-diff').classList.toggle('hidden', which !== 'markdown');
  $('conflict-bar').classList.toggle('hidden', which !== 'conflict');
}

function setDiffHeader(file: DiffableFile, extra?: string): void {
  $('diff-file-path').textContent =
    (file.origPath ? `${file.origPath} → ${file.path}` : file.path) + (extra || '');
  $('diff-file-path').classList.remove('dim');
  const icon = $('diff-file-icon');
  icon.className = 'file-name ' + file.type;
  icon.textContent = TYPE_ICON[file.type] || '●';
  $('diff-empty').classList.add('hidden');
}

function showImageDiff(diff: ImagePayloadLike): void {
  const set = (imgId: string, missId: string, capId: string, b64: string | null) => {
    const img = $<HTMLImageElement>(imgId);
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

// Common prologue for loading anything new into the diff pane.
function resetDiffPane(): void {
  state.f7Armed = false;
  state.shiftF7Armed = false;
  closeConflictSession();
  state.imageDiff = null;
  for (const id of ['btn-image-view', 'btn-md-view']) {
    const btn = $(id);
    btn.classList.add('hidden');
    btn.classList.remove('active');
  }
}

interface PresentDiffOptions {
  readOnly: boolean;
  revealEnd?: boolean;
  trackPath: boolean;
}

// Install a loaded diff payload into the pane: image preview for binary
// images, a placeholder for binary/oversized files, or fresh Monaco models.
// `trackPath` ties the models to a worktree path for hunk staging;
// `revealEnd` positions on the last change instead of the first.
function presentDiff(diff: DiffPayload, file: DiffableFile, { readOnly, revealEnd, trackPath }: PresentDiffOptions): void {
  disposeModels();
  showPane('diff');
  setDirty(false);

  if (diff.binary && diff.image) {
    showImageDiff({
      imageMime: diff.imageMime!,
      originalImage: diff.originalImage ?? null,
      modifiedImage: diff.modifiedImage ?? null,
    });
    return;
  }

  if (diff.binary || diff.tooLarge) {
    const note = diff.binary ? 'Binary file — cannot show diff' : 'File is too large to diff';
    originalModel = monaco.editor.createModel('', 'plaintext');
    modifiedModel = monaco.editor.createModel(note, 'plaintext');
    diffEditor!.setModel({ original: originalModel, modified: modifiedModel });
    diffEditor!.updateOptions({ readOnly: true });
    updateDiffCount();
    return;
  }

  const lang = languageFor(file.path, diff.modified || diff.original);
  originalModel = monaco.editor.createModel(diff.original, lang);
  modifiedModel = monaco.editor.createModel(diff.modified, lang);
  if (lang === 'markdown') $('btn-md-view').classList.remove('hidden');
  if (trackPath) currentModelsPath = file.path;
  diffEditor!.setModel({ original: originalModel, modified: modifiedModel });
  diffEditor!.updateOptions({ readOnly });

  // Text file with an image preview available (SVG). The base64 payload is
  // fetched on demand when the preview toggle is first used.
  if (diff.image) {
    state.imageDiff = {
      file,
      hash: state.readOnlyDiff ? state.readOnlyDiff.hash : null,
      // diff.image guarantees these are populated even though DiffPayload's
      // fields are optional (also covering the tooLarge/binary variants).
      payload: diff.originalImage !== undefined
        ? { imageMime: diff.imageMime!, originalImage: diff.originalImage ?? null, modifiedImage: diff.modifiedImage ?? null }
        : null,
    };
    $('btn-image-view').classList.remove('hidden');
  }

  if (!readOnly) {
    modifiedModel.onDidChangeContent(() => {
      if (!suppressModelEvents) {
        setDirty(true);
        clearBlame(); // annotations are stale once the buffer is edited
      }
    });
    if (state.blameOn) applyBlame();
  }

  // Position on the first (or last) change once the diff has been computed.
  const once = diffEditor!.onDidUpdateDiff(() => {
    once.dispose();
    const changes = getLineChanges();
    if (changes.length) {
      gotoChange(revealEnd ? changes[changes.length - 1]! : changes[0]!);
    }
    updateDiffCount();
  });
}

async function openDiff(file: FileEntry, revealEnd?: boolean): Promise<void> {
  await monacoReady;
  await autosaveIfDirty();

  state.current = file;
  state.readOnlyDiff = null;
  resetDiffPane();
  setDiffHeader(file);

  if (file.type === 'CONFLICT') {
    setDirty(false);
    disposeModels();
    updateDiffCount();
    return openConflict(file);
  }

  let diff: DiffPayload;
  try {
    diff = await window.api.gitDiff(file.path, file.type, file.origPath);
  } catch (err) {
    toast('Failed to load diff: ' + errMsg(err), true);
    return;
  }
  if (state.current !== file || state.conflict) return; // user moved on while we loaded

  presentDiff(diff, file, {
    readOnly: file.type === 'DELETED',
    revealEnd,
    trackPath: true,
  });
}

// Read-only diff of one file inside a commit (Log tab / file history).
async function openCommitFileDiff(commit: CommitDetails, file: CommitFile): Promise<void> {
  await monacoReady;
  await autosaveIfDirty();

  state.current = null;
  state.readOnlyDiff = { hash: commit.hash, path: file.path };
  resetDiffPane();
  setDiffHeader(file, ` @ ${commit.short}`);

  let diff: DiffPayload;
  try {
    diff = await window.api.gitCommitFileDiff(commit.hash, file.path, file.type, file.origPath);
  } catch (err) {
    toast('Failed to load diff: ' + errMsg(err), true);
    return;
  }
  if (
    !state.readOnlyDiff ||
    state.readOnlyDiff.hash !== commit.hash ||
    state.readOnlyDiff.path !== file.path
  ) {
    return; // user clicked another file while this diff loaded
  }

  presentDiff(diff, file, { readOnly: true, revealEnd: false, trackPath: false });
}

// Rendered markdown preview: fill the Old/New panes from the live diff
// models (so unsaved edits show up) and switch the pane over.
function showMarkdownDiff(): void {
  if (!originalModel || !modifiedModel) return;
  const relPath = state.current?.path ?? state.readOnlyDiff?.path ?? null;
  const base =
    state.repo && relPath
      ? { root: state.repo.root, dir: relPath.split('/').slice(0, -1).join('/') }
      : null;
  const oldText = originalModel.getValue();
  const newText = modifiedModel.getValue();
  renderMarkdownPane($('md-old'), oldText, base);
  renderMarkdownPane($('md-new'), newText, base);
  // One-sided diff (added or deleted file): give the whole pane to the side
  // that exists instead of wasting half the width on "(none)".
  const oldEmpty = !oldText.trim();
  const newEmpty = !newText.trim();
  $('md-old-pane').classList.toggle('hidden', oldEmpty && !newEmpty);
  $('md-new-pane').classList.toggle('hidden', newEmpty && !oldEmpty);
  showPane('markdown');
}

function renderMarkdownPane(el: HTMLElement, text: string, base: MarkdownBase | null): void {
  if (!text.trim()) {
    el.textContent = '';
    const span = document.createElement('span');
    span.className = 'md-none';
    span.textContent = '(none)';
    el.appendChild(span);
    return;
  }
  renderMarkdownInto(el, text, base);
}

function disposeModels(): void {
  suppressModelEvents = true;
  if (diffEditor) diffEditor.setModel(null);
  if (originalModel) originalModel.dispose();
  if (modifiedModel) modifiedModel.dispose();
  originalModel = modifiedModel = null;
  currentModelsPath = null;
  suppressModelEvents = false;
}

function setDirty(d: boolean): void {
  state.dirty = d;
  $('diff-dirty').textContent = d ? '*' : '';
}

function editableModel(): monaco.editor.ITextModel | null {
  if (state.conflict && conflictModel) return conflictModel;
  if (state.current && !state.readOnlyDiff && modifiedModel) return modifiedModel;
  return null;
}

async function autosaveIfDirty(): Promise<void> {
  const model = editableModel();
  if (!state.dirty || !state.current || !model) return;
  try {
    await window.api.saveFile(state.current.path, model.getValue());
    setDirty(false);
  } catch (err) {
    toast('Autosave failed: ' + errMsg(err), true);
  }
}

async function saveCurrent(): Promise<void> {
  const model = editableModel();
  if (!state.current || !model) return;
  try {
    await window.api.saveFile(state.current.path, model.getValue());
    setDirty(false);
    statusMsg('Saved ' + state.current.path);
    await refreshStatus(true);
  } catch (err) {
    toast('Save failed: ' + errMsg(err), true);
  }
}

function focusEditor(): void {
  if (state.conflict && conflictEditor) conflictEditor.focus();
  else if (diffEditor && state.current) diffEditor.getModifiedEditor().focus();
}
