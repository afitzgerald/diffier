'use strict';

/* Menu IPC, toolbar wiring, splitter, startup.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

// ---------------------------------------------------------------- menu ipc

window.api.onMenu((id) => {
  if (id === 'window-focus') return void refreshStatus(true);
  if (id.startsWith('theme:')) return void setTheme(id.slice('theme:'.length) as ThemeId);
  runAction(id);
});

window.api.onRepoChanged(() => refreshStatus(state.dirty));
if (window.api.onRepoOpened) window.api.onRepoOpened((repo) => setRepo(repo));

// Keep the markdown-diff ruler in sync with content reflow (zoom changes
// the font size, window resizes change wrapping) without threading a
// callback through every place that could cause either.
new ResizeObserver(updateMdDiffRuler).observe($('md-diff-body'));

// ---------------------------------------------------------------- toolbar

$('btn-refresh').addEventListener('click', () => refreshStatus());
$('btn-rollback').addEventListener('click', doRollback);

// Expand/Collapse All apply to whichever file tree the active tab shows.
$('btn-expand-all').addEventListener('click', () => {
  if (state.view === 'log') {
    if (!state.log.details) return;
    state.log.collapsed.clear();
    renderCommitFileTree(state.log.details);
  } else if (state.view === 'compare') {
    state.compare.collapsed.clear();
    renderCompareFileTree();
  } else {
    state.collapsed.clear();
    renderTree();
  }
});
$('btn-collapse-all').addEventListener('click', () => {
  if (state.view === 'log') {
    if (!state.log.details) return;
    state.log.collapsed = new Set(allDirKeys(state.log.details.files));
    renderCommitFileTree(state.log.details);
  } else if (state.view === 'compare') {
    state.compare.collapsed = new Set(allDirKeys(state.compare.files));
    renderCompareFileTree();
  } else {
    state.collapsed = new Set(allDirKeys(state.files));
    renderTree();
  }
});
$('btn-next-diff').addEventListener('click', nextDifference);
$('btn-prev-diff').addEventListener('click', prevDifference);
$('btn-next-file').addEventListener('click', () => selectNextFile());
$('btn-prev-file').addEventListener('click', () => selectPrevFile(true));
$('btn-commit').addEventListener('click', () => doCommit(false));
$('btn-commit-push').addEventListener('click', () => doCommit(true));

$('viewer-mode').addEventListener('change', async (e) => {
  await monacoReady;
  const side = (e.target as HTMLSelectElement).value === 'side';
  diffEditor!.updateOptions({ renderSideBySide: side });
  window.api.setSettings({ viewMode: (e.target as HTMLSelectElement).value as 'side' | 'unified' });
});

$('btn-whitespace').addEventListener('click', async (e) => {
  await monacoReady;
  const btn = e.currentTarget as HTMLElement;
  btn.classList.toggle('active');
  const ignore = btn.classList.contains('active');
  diffEditor!.updateOptions({ ignoreTrimWhitespace: ignore });
});

$('btn-word-wrap').addEventListener('click', async (e) => {
  await monacoReady;
  const btn = e.currentTarget as HTMLElement;
  btn.classList.toggle('active');
  const on = btn.classList.contains('active');
  diffEditor!.updateOptions({ diffWordWrap: on ? 'on' : 'off' });
});

$('btn-collapse-unchanged').addEventListener('click', async (e) => {
  await monacoReady;
  const btn = e.currentTarget as HTMLElement;
  btn.classList.toggle('active');
  const on = btn.classList.contains('active');
  diffEditor!.updateOptions({ hideUnchangedRegions: { enabled: on } });
});

$('btn-blame').addEventListener('click', toggleBlame);

// SVG files: flip between the text diff and the rendered image preview. The
// base64 payload is fetched lazily on first use and cached on the descriptor.
$('btn-image-view').addEventListener('click', async (e) => {
  const btn = e.currentTarget as HTMLElement;
  const showImage = !btn.classList.contains('active');
  btn.classList.toggle('active', showImage);
  if (!showImage) {
    showPane('diff');
    updateDiffCount();
    return;
  }
  const d = state.imageDiff;
  if (!d) return;
  if (!d.payload) {
    try {
      d.payload = await window.api.gitImageData(d.file.path, d.file.type, d.file.origPath, d.leftRef, d.rightRef);
    } catch (err) {
      btn.classList.remove('active');
      toast('Image preview failed: ' + errMsg(err), true);
      return;
    }
    if (state.imageDiff !== d) return; // switched files while loading
  }
  showImageDiff(d.payload);
});

// Markdown files: flip between the text diff and the unified rendered view.
$('btn-md-view').addEventListener('click', (e) => {
  const btn = e.currentTarget as HTMLElement;
  const show = !btn.classList.contains('active');
  btn.classList.toggle('active', show);
  if (show) {
    showMarkdownPane('diff');
  } else {
    showPane('diff');
    updateDiffCount();
  }
});

// Diff / Old / New buttons inside the markdown pane itself.
$('md-mode-bar').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-md-mode]');
  if (btn) showMarkdownPane(btn.dataset.mdMode as MdPaneMode);
});

// Links in rendered markdown never navigate the window (main blocks
// navigation anyway); http(s) targets open in the system browser.
function activateMarkdownLink(a: HTMLAnchorElement): void {
  const href = a.dataset.href || '';
  if (/^https?:\/\//i.test(href)) {
    window.api.openExternal(href).catch((err) => toast('Could not open link: ' + errMsg(err), true));
  }
}
$('markdown-diff').addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a');
  if (!a) return;
  e.preventDefault();
  activateMarkdownLink(a);
});
$('markdown-diff').addEventListener('keydown', (e) => {
  const ke = e as KeyboardEvent;
  if (ke.key !== 'Enter') return;
  const a = (ke.target as HTMLElement).closest('a');
  if (!a) return;
  e.preventDefault();
  activateMarkdownLink(a);
});

// Conflict bar.
$('btn-prev-conflict').addEventListener('click', () => gotoConflict(-1));
$('btn-next-conflict').addEventListener('click', () => gotoConflict(1));
$('btn-all-ours').addEventListener('click', () => acceptAllConflicts('ours'));
$('btn-all-theirs').addEventListener('click', () => acceptAllConflicts('theirs'));
$('btn-mark-resolved').addEventListener('click', markResolved);

$('amend-checkbox').addEventListener('change', async (e) => {
  if ((e.target as HTMLInputElement).checked && !$<HTMLTextAreaElement>('commit-message').value.trim()) {
    try {
      $<HTMLTextAreaElement>('commit-message').value = await window.api.gitLastMessage();
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------- splitter

(() => {
  const splitter = $('splitter');
  const panel = $('commit-panel');
  let dragging = false;
  splitter.addEventListener('mousedown', () => {
    dragging = true;
    document.body.style.cursor = 'col-resize';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // With the file list on the right the splitter sits to its left, so the
    // panel width is measured from the window's right edge instead.
    const x = state.settings.panelSide === 'right' ? window.innerWidth - e.clientX : e.clientX;
    const w = Math.min(window.innerWidth * 0.6, Math.max(180, x));
    panel.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor = '';
      window.api.setSettings({ panelWidth: parseInt(panel.style.width, 10) || 360 });
    }
  });
})();

// -------------------------------------------------------------------- boot

(async () => {
  try {
    state.settings = await window.api.getSettings();
  } catch {
    state.settings = {};
  }
  if (state.settings.panelWidth) {
    $('commit-panel').style.width = state.settings.panelWidth + 'px';
  }
  applyPanelSide(state.settings.panelSide || 'left');
  if (state.settings.viewMode === 'unified') {
    $<HTMLSelectElement>('viewer-mode').value = 'unified';
  }
  if (state.settings.wordWrap !== false) {
    $('btn-word-wrap').classList.add('active');
    $<HTMLInputElement>('default-word-wrap').checked = true;
  }
  if (state.settings.ignoreWhitespace) {
    $('btn-whitespace').classList.add('active');
    $<HTMLInputElement>('default-ignore-whitespace').checked = true;
  }
  if (state.settings.collapseUnchanged) {
    $('btn-collapse-unchanged').classList.add('active');
    $<HTMLInputElement>('default-collapse-unchanged').checked = true;
  }
  km.overrides = { ...(state.settings.keymap || {}) };
  rebuildKeymap();
  applyTheme(state.settings.theme || DEFAULT_THEME);
  await monacoReady;
  // Monaco may have initialized before settings arrived — reapply so the
  // editor theme matches the persisted choice.
  applyTheme(state.settings.theme || DEFAULT_THEME);
  diffEditor!.updateOptions({
    renderSideBySide: state.settings.viewMode !== 'unified',
    diffWordWrap: state.settings.wordWrap === false ? 'off' : 'on',
    ignoreTrimWhitespace: !!state.settings.ignoreWhitespace,
    hideUnchangedRegions: { enabled: !!state.settings.collapseUnchanged },
  });
  try {
    const repo = await window.api.openLastRepo();
    if (repo) await setRepo(repo);
  } catch {
    /* stay on the empty state */
  }
})();
