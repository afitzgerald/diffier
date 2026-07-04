'use strict';
/* Menu IPC, toolbar wiring, splitter, startup.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */
// ---------------------------------------------------------------- menu ipc
window.api.onMenu((id) => {
    if (id === 'window-focus')
        return void refreshStatus(true);
    if (id.startsWith('theme:'))
        return void setTheme(id.slice('theme:'.length));
    runAction(id);
});
window.api.onRepoChanged(() => refreshStatus(state.dirty));
if (window.api.onRepoOpened)
    window.api.onRepoOpened((repo) => setRepo(repo));
// ---------------------------------------------------------------- toolbar
$('btn-refresh').addEventListener('click', () => refreshStatus());
$('btn-rollback').addEventListener('click', doRollback);
$('btn-expand-all').addEventListener('click', () => {
    state.collapsed.clear();
    renderTree();
});
$('btn-collapse-all').addEventListener('click', () => {
    const walk = (rows) => {
        for (const r of rows)
            if (r.kind === 'dir')
                state.collapsed.add(r.key);
    };
    // Flatten with nothing collapsed to find every dir key.
    state.collapsed.clear();
    const all = [];
    flattenRows(buildTree(state.files), 0, '', all);
    walk(all);
    renderTree();
});
$('btn-next-diff').addEventListener('click', nextDifference);
$('btn-prev-diff').addEventListener('click', prevDifference);
$('btn-next-file').addEventListener('click', () => selectFileByOffset(1));
$('btn-prev-file').addEventListener('click', () => selectFileByOffset(-1, true));
$('btn-commit').addEventListener('click', () => doCommit(false));
$('btn-commit-push').addEventListener('click', () => doCommit(true));
$('viewer-mode').addEventListener('change', async (e) => {
    await monacoReady;
    const side = e.target.value === 'side';
    diffEditor.updateOptions({ renderSideBySide: side });
    window.api.setSettings({ viewMode: e.target.value });
});
$('btn-whitespace').addEventListener('click', async (e) => {
    await monacoReady;
    const btn = e.currentTarget;
    btn.classList.toggle('active');
    const ignore = btn.classList.contains('active');
    diffEditor.updateOptions({ ignoreTrimWhitespace: ignore });
    window.api.setSettings({ ignoreWhitespace: ignore });
});
$('btn-collapse-unchanged').addEventListener('click', async (e) => {
    await monacoReady;
    const btn = e.currentTarget;
    btn.classList.toggle('active');
    const on = btn.classList.contains('active');
    diffEditor.updateOptions({ hideUnchangedRegions: { enabled: on } });
    window.api.setSettings({ collapseUnchanged: on });
});
$('btn-blame').addEventListener('click', toggleBlame);
// SVG files: flip between the text diff and the rendered image preview. The
// base64 payload is fetched lazily on first use and cached on the descriptor.
$('btn-image-view').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const showImage = !btn.classList.contains('active');
    btn.classList.toggle('active', showImage);
    if (!showImage) {
        showPane('diff');
        updateDiffCount();
        return;
    }
    const d = state.imageDiff;
    if (!d)
        return;
    if (!d.payload) {
        try {
            d.payload = await window.api.gitImageData(d.file.path, d.file.type, d.file.origPath, d.hash);
        }
        catch (err) {
            btn.classList.remove('active');
            toast('Image preview failed: ' + errMsg(err), true);
            return;
        }
        if (state.imageDiff !== d)
            return; // switched files while loading
    }
    showImageDiff(d.payload);
});
// Conflict bar.
$('btn-prev-conflict').addEventListener('click', () => gotoConflict(-1));
$('btn-next-conflict').addEventListener('click', () => gotoConflict(1));
$('btn-all-ours').addEventListener('click', () => acceptAllConflicts('ours'));
$('btn-all-theirs').addEventListener('click', () => acceptAllConflicts('theirs'));
$('btn-mark-resolved').addEventListener('click', markResolved);
$('amend-checkbox').addEventListener('change', async (e) => {
    if (e.target.checked && !$('commit-message').value.trim()) {
        try {
            $('commit-message').value = await window.api.gitLastMessage();
        }
        catch {
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
        if (!dragging)
            return;
        const w = Math.min(window.innerWidth * 0.6, Math.max(180, e.clientX));
        panel.style.width = w + 'px';
    });
    window.addEventListener('mouseup', () => {
        if (dragging) {
            dragging = false;
            document.body.style.cursor = '';
            window.api.setSettings({ panelWidth: parseInt(panel.style.width, 10) || 300 });
        }
    });
})();
// -------------------------------------------------------------------- boot
(async () => {
    try {
        state.settings = await window.api.getSettings();
    }
    catch {
        state.settings = {};
    }
    if (state.settings.panelWidth) {
        $('commit-panel').style.width = state.settings.panelWidth + 'px';
    }
    if (state.settings.viewMode === 'unified') {
        $('viewer-mode').value = 'unified';
    }
    if (state.settings.ignoreWhitespace) {
        $('btn-whitespace').classList.add('active');
    }
    if (state.settings.collapseUnchanged) {
        $('btn-collapse-unchanged').classList.add('active');
    }
    km.overrides = { ...(state.settings.keymap || {}) };
    rebuildKeymap();
    applyTheme(state.settings.theme || DEFAULT_THEME);
    await monacoReady;
    // Monaco may have initialized before settings arrived — reapply so the
    // editor theme matches the persisted choice.
    applyTheme(state.settings.theme || DEFAULT_THEME);
    diffEditor.updateOptions({
        renderSideBySide: state.settings.viewMode !== 'unified',
        ignoreTrimWhitespace: !!state.settings.ignoreWhitespace,
        hideUnchangedRegions: { enabled: !!state.settings.collapseUnchanged },
    });
    try {
        const repo = await window.api.openLastRepo();
        if (repo)
            await setRepo(repo);
    }
    catch {
        /* stay on the empty state */
    }
})();
