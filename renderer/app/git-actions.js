'use strict';
/* Commit, push, pull, fetch, rollback.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */
// ------------------------------------------------------------- git actions
async function doCommit(alsoPush) {
    await autosaveIfDirty();
    const { full, partials, skipped } = commitSelection();
    const files = full.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));
    const message = $('commit-message').value;
    const amend = $('amend-checkbox').checked;
    if (!files.length && !partials.length) {
        toast(skipped.length ? 'All hunks of the selected files are excluded' : 'No files selected for commit', true);
        return;
    }
    const conflicted = full.filter((f) => f.type === 'CONFLICT');
    if (conflicted.length) {
        toast(`Resolve conflicts before committing: ${conflicted[0].path}`, true);
        return;
    }
    // Concluding a merge commits the whole staged index (git forbids pathspec
    // commits there) — be honest about it when files are left unchecked.
    if (state.merging && state.checked.size < state.files.length) {
        const ok = await window.api.confirm({
            message: 'Concluding a merge commits all staged changes',
            detail: 'Git does not allow file-limited commits while a merge is in progress; unchecked files that are staged will be included.',
            confirmLabel: 'Commit All Staged',
        });
        if (!ok)
            return;
    }
    // The commit message template is boilerplate, not a message.
    const effectiveMsg = message.trim() === state.commitTemplate.trim() ? '' : message;
    if (!effectiveMsg.trim() && !amend) {
        toast('Specify commit message', true);
        $('commit-message').focus();
        return;
    }
    try {
        $('btn-commit').disabled = true;
        $('btn-commit-push').disabled = true;
        await window.api.gitCommit({ files, message: effectiveMsg, amend, partials });
        const subject = effectiveMsg.split('\n')[0].slice(0, 60);
        rememberCommitMessage(effectiveMsg);
        $('commit-message').value = state.commitTemplate || '';
        updateSubjectLength();
        $('amend-checkbox').checked = false;
        for (const p of partials)
            state.hunks.delete(p.path);
        for (const f of full)
            state.hunks.delete(f.path);
        statusMsg('');
        if (alsoPush) {
            statusMsg('Pushing…');
            await window.api.gitPush();
            statusMsg('');
            toast(`Committed and pushed: ${subject || '(amend)'}`);
        }
        else {
            toast(`Committed: ${subject || '(amend)'}`);
        }
        await refreshStatus();
        if (state.view === 'log')
            await loadLog(true);
    }
    catch (err) {
        toast(errMsg(err), true);
    }
    finally {
        updateCommitCount();
    }
}
function rememberCommitMessage(message) {
    const msg = (message || '').trim();
    if (!msg)
        return;
    const history = [msg, ...(state.settings.commitHistory || []).filter((m) => m !== msg)].slice(0, 25);
    state.settings.commitHistory = history;
    window.api.setSettings({ commitHistory: history }).catch(() => { });
}
async function doPush() {
    try {
        statusMsg('Pushing…');
        const out = await window.api.gitPush();
        statusMsg('');
        toast(out.trim() ? out.trim().split('\n').pop() : 'Pushed');
    }
    catch (err) {
        statusMsg('');
        toast('Push failed: ' + errMsg(err), true);
    }
}
async function doRollback() {
    const row = selectedRow();
    if (!row)
        return;
    const files = row.kind === 'file' ? [row.file] : collectFiles(row.node);
    if (!files.length)
        return;
    const names = files.length === 1 ? files[0].path : `${files.length} files`;
    const ok = await window.api.confirm({
        message: `Rollback ${names}?`,
        detail: 'Local changes will be reverted to the repository version. Unversioned files will be deleted.',
        confirmLabel: 'Rollback',
    });
    if (!ok)
        return;
    try {
        if (state.current && files.some((f) => f.path === state.current.path)) {
            setDirty(false); // don't autosave what we're about to revert
        }
        await window.api.gitRollback(files.map((f) => ({ path: f.path, type: f.type, origPath: f.origPath })));
        toast(`Rolled back ${names}`);
        await refreshStatus();
    }
    catch (err) {
        toast('Rollback failed: ' + errMsg(err), true);
    }
}
async function doPull() {
    try {
        statusMsg('Pulling…');
        const out = await window.api.gitPull();
        statusMsg('');
        toast(out.trim() ? out.trim().split('\n').pop() : 'Pulled');
        await refreshStatus();
        if (state.view === 'log')
            await loadLog(true);
    }
    catch (err) {
        statusMsg('');
        toast('Pull failed: ' + errMsg(err), true);
    }
}
async function doFetch() {
    try {
        statusMsg('Fetching…');
        await window.api.gitFetch();
        statusMsg('');
        toast('Fetched');
        await refreshStatus();
    }
    catch (err) {
        statusMsg('');
        toast('Fetch failed: ' + errMsg(err), true);
    }
}
