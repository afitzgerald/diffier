'use strict';

/* Action registry and global keyboard handling.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

// ---------------------------------------------------------------- actions

const ACTION_IMPL: Partial<Record<ActionId, () => void>> = {
  'next-diff': () => nextDifference(),
  'prev-diff': () => prevDifference(),
  'next-file': () => void selectFileByOffset(1),
  'prev-file': () => void selectFileByOffset(-1, true),
  'focus-tree': () => {
    state.f7Armed = false;
    state.shiftF7Armed = false;
    treeEl.focus();
  },
  commit: () => {
    $('commit-panel').classList.remove('hidden');
    setView('commit');
    $('commit-message').focus();
  },
  'commit-execute': () => void doCommit(false),
  'commit-and-push': () => void doCommit(true),
  'commit-history': () => {
    // The popup anchors to the commit message box — make sure it's visible,
    // or an invisible popup would swallow every shortcut until Escape.
    $('commit-panel').classList.remove('hidden');
    setView('commit');
    toggleMsgHistory();
  },
  push: () => void doPush(),
  pull: () => void doPull(),
  fetch: () => void doFetch(),
  branches: () => void openBranchPopup(),
  stash: () => openStashDialog(),
  rollback: () => void doRollback(),
  save: () => void saveCurrent(),
  'open-repo': () => void openRepoDialog(),
  refresh: () => void refreshStatus(),
  'toggle-panel': () => {
    const panel = $('commit-panel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) treeEl.focus();
  },
  'toggle-log': () => {
    const panel = $('commit-panel');
    if (state.view === 'log' && !panel.classList.contains('hidden')) {
      panel.classList.add('hidden');
    } else {
      panel.classList.remove('hidden');
      setView('log');
    }
  },
  filter: () => {
    $('commit-panel').classList.remove('hidden');
    setView('commit');
    $('tree-filter').focus();
    $<HTMLInputElement>('tree-filter').select();
  },
  annotate: () => toggleBlame(),
  'zoom-in': () => zoomIn(),
  'zoom-out': () => zoomOut(),
  'zoom-reset': () => zoomReset(),
  'keymap-settings': () => toggleKeymapDialog(),
  'about-dialog': () => toggleAboutDialog(),
};

function runAction(id: ActionId | string): void {
  const impl = ACTION_IMPL[id as ActionId];
  if (impl) impl();
}

// -------------------------------------------------------------- keybinding

// Fixed tree-navigation keys (not part of the customizable keymap).
function handleTreeKey(e: KeyboardEvent): boolean {
  if (document.activeElement !== treeEl) return false;
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  const row = selectedRow();
  switch (e.key) {
    case 'ArrowDown':
      moveSelection(1);
      return true;
    case 'ArrowUp':
      moveSelection(-1);
      return true;
    case 'ArrowRight':
      if (row && row.kind === 'dir' && state.collapsed.has(row.key)) toggleCollapse(row.key);
      else moveSelection(1);
      return true;
    case 'ArrowLeft':
      if (row && row.kind === 'dir' && !state.collapsed.has(row.key)) toggleCollapse(row.key);
      return true;
    case ' ':
      if (row) {
        if (row.kind === 'file') toggleChecked(row.file.path);
        else {
          const all = collectFiles(row.node);
          const anyUnchecked = all.some((f) => !state.checked.has(f.path));
          for (const f of all) {
            if (anyUnchecked) state.checked.add(f.path);
            else state.checked.delete(f.path);
          }
          renderTree();
        }
      }
      return true;
    case 'Enter':
      if (row && row.kind === 'file') focusEditor();
      else if (row) toggleCollapse(row.key);
      return true;
    default:
      return false;
  }
}

window.addEventListener(
  'keydown',
  (e) => {
    // Shortcut recording captures everything first.
    if (km.recordingAction) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return stopRecording();
      const b = eventToBinding(e);
      if (b) assignBinding(km.recordingAction, b);
      return;
    }

    // Popups and the stash dialog swallow Escape before anything else.
    if (anyPopupOpen()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePopups();
      }
      return;
    }
    if (stashOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeStashDialog();
      }
      return;
    }

    // While the keymap dialog is open, only Escape (close) is handled.
    if (km.dialogOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeKeymapDialog();
      }
      return;
    }

    // While the About dialog is open, only Escape (close) is handled.
    if (aboutOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAboutDialog();
      }
      return;
    }

    // Fixed tree navigation wins over the keymap when the tree has focus.
    if (handleTreeKey(e)) {
      e.preventDefault();
      return;
    }

    // Alt+Left/Right — fixed secondary binding for prev/next changed file
    // when the tree has focus (Option+arrow stays word navigation in text).
    if (
      e.altKey && !e.metaKey && !e.ctrlKey &&
      (e.key === 'ArrowRight' || e.key === 'ArrowLeft') &&
      document.activeElement === treeEl
    ) {
      e.preventDefault();
      selectFileByOffset(e.key === 'ArrowRight' ? 1 : -1, e.key === 'ArrowLeft');
      return;
    }

    // Customizable keymap.
    const b = eventToBinding(e);
    const actionId = b && km.byBinding.get(b);
    if (actionId && bindingAllowedHere(b)) {
      e.preventDefault();
      e.stopPropagation();
      runAction(actionId);
    }
  },
  true
);

window.addEventListener('blur', () => void autosaveIfDirty());
