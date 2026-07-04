'use strict';
/* Repository lifecycle: status refresh, setRepo, open dialog.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */
// ------------------------------------------------------------------ status
async function refreshStatus(keepDiff) {
    if (!state.repo)
        return;
    const root = state.repo.root;
    let st;
    try {
        st = await window.api.gitStatus();
    }
    catch (err) {
        toast('git status failed: ' + errMsg(err), true);
        return;
    }
    // The user may have switched repositories while the status was in flight.
    if (!state.repo || state.repo.root !== root)
        return;
    state.files = st.files;
    const wasMerging = state.merging;
    state.merging = !!st.merging;
    $('status-branch').textContent = st.branch;
    $('status-track').textContent = st.track
        ? [st.track.ahead ? `↑${st.track.ahead}` : '', st.track.behind ? `↓${st.track.behind}` : '']
            .filter(Boolean)
            .join(' ')
        : '';
    // During a merge, git refuses pathspec-limited and per-hunk commits — the
    // whole staged index is committed. Surface the mode instead of failing at
    // commit time.
    if (state.merging !== wasMerging) {
        statusMsg(state.merging ? 'Merge in progress — commit records all staged changes' : '');
        updateHunkDecorations();
    }
    if (window.api.setBadge) {
        Promise.resolve(window.api.setBadge(st.files.length)).catch(() => { });
    }
    // New files default to checked, like IntelliJ's commit window.
    for (const f of st.files) {
        if (!state.known.has(f.path)) {
            state.known.add(f.path);
            state.checked.add(f.path);
        }
    }
    const paths = new Set(st.files.map((f) => f.path));
    for (const p of [...state.checked])
        if (!paths.has(p))
            state.checked.delete(p);
    for (const p of [...state.hunks.keys()])
        if (!paths.has(p))
            state.hunks.delete(p);
    renderTree();
    if (state.readOnlyDiff)
        return; // a commit diff from the Log tab is showing
    if (state.current) {
        const cur = st.files.find((f) => f.path === state.current.path);
        if (!cur) {
            // File no longer changed (committed / rolled back) — clear the diff.
            clearDiffView();
        }
        else if (cur.type !== state.current.type) {
            // e.g. a conflict was resolved or re-appeared — reopen in the right view.
            const key = 'file:' + cur.path;
            state.current = cur;
            if (state.selectedKey === key)
                openDiff(cur);
        }
        else if (!keepDiff && !state.dirty && !state.conflict) {
            // Reload the open diff (e.g. file changed on disk) preserving position.
            const pos = diffEditor && diffEditor.getModifiedEditor().getPosition();
            const scroll = diffEditor && diffEditor.getModifiedEditor().getScrollTop();
            openDiff(cur).then(() => {
                if (pos && modifiedModel) {
                    const ed = diffEditor.getModifiedEditor();
                    ed.setPosition(pos);
                    ed.setScrollTop(scroll);
                }
            });
        }
    }
}
function clearDiffView() {
    state.current = null;
    state.readOnlyDiff = null;
    closeConflictSession();
    disposeModels();
    showPane('diff');
    $('btn-image-view').classList.add('hidden');
    $('diff-file-path').textContent = 'No file selected';
    $('diff-file-path').classList.add('dim');
    $('diff-file-icon').textContent = '';
    $('diff-dirty').textContent = '';
    $('diff-count').textContent = '';
    $('diff-empty').classList.remove('hidden');
    $('empty-hint').innerHTML =
        'Select a changed file — <kbd>↑</kbd><kbd>↓</kbd> in the tree, <kbd>F7</kbd> to step through diffs';
}
// ------------------------------------------------------------------- repo
async function setRepo(repo) {
    if (!repo)
        return;
    state.repo = repo;
    state.known.clear();
    state.checked.clear();
    state.collapsed.clear();
    state.hunks.clear();
    state.filter = '';
    $('tree-filter').value = '';
    $('tree-filter-clear').classList.add('hidden');
    resetLog(null);
    clearDiffView();
    $('titlebar-repo').textContent = repo.name;
    $('titlebar-worktree').classList.toggle('hidden', !repo.isWorktree);
    $('status-path').textContent = repo.root;
    document.title = `${repo.name} – Diffier`;
    // Prefill the commit message from the repo's commit.template, if any.
    state.commitTemplate = '';
    try {
        if (window.api.gitCommitTemplate)
            state.commitTemplate = await window.api.gitCommitTemplate();
    }
    catch {
        /* optional */
    }
    const msgBox = $('commit-message');
    if (!msgBox.value.trim() && state.commitTemplate) {
        msgBox.value = state.commitTemplate;
        updateSubjectLength();
    }
    await refreshStatus();
    if (state.view === 'log')
        await loadLog(true);
    // Auto-select the first changed file, like opening IntelliJ's diff preview.
    const rows = fileRows();
    if (rows.length)
        selectRow(rows[0].key);
    treeEl.focus();
}
async function openRepoDialog() {
    try {
        const repo = await window.api.openRepoDialog();
        if (repo)
            await setRepo(repo);
    }
    catch (err) {
        toast(errMsg(err), true);
    }
}
