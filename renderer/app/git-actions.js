'use strict';

/* Commit, push, pull, fetch, rollback.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

/* global monaco */

// ------------------------------------------------------------- git actions

async function doCommit(alsoPush) {
  await autosaveIfDirty();
  const { full, partials, skipped } = commitSelection();
  const files = full.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));
  const message = $('commit-message').value;
  const amend = $('amend-checkbox').checked;
  if (!files.length && !partials.length) {
    toast(
      skipped.length ? 'All hunks of the selected files are excluded' : 'No files selected for commit',
      true
    );
    return;
  }
  const conflicted = full.filter((f) => f.type === 'CONFLICT');
  if (conflicted.length) {
    toast(`Resolve conflicts before committing: ${conflicted[0].path}`, true);
    return;
  }
  // A hunk selection was computed against the file content at the time its
  // diff was open. If the file (or HEAD) changed since, the prepared partial
  // content would silently commit stale text — verify before committing.
  for (const p of partials) {
    const entry = state.hunks.get(p.path);
    if (!entry || entry.snapshotModified == null) continue;
    try {
      const d = await window.api.gitDiff(p.path, 'MODIFIED', null);
      if (d.modified !== entry.snapshotModified || d.original !== entry.snapshotOriginal) {
        state.hunks.delete(p.path);
        updateCommitCount();
        toast(`${p.path} changed since its hunks were selected — reopen it and reselect`, true);
        return;
      }
    } catch {
      /* diff unavailable — let the commit surface the error */
    }
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
    for (const p of partials) state.hunks.delete(p.path);
    for (const f of full) state.hunks.delete(f.path);
    statusMsg('');
    if (alsoPush) {
      statusMsg('Pushing…');
      await window.api.gitPush();
      statusMsg('');
      toast(`Committed and pushed: ${subject || '(amend)'}`);
    } else {
      toast(`Committed: ${subject || '(amend)'}`);
    }
    await refreshStatus();
    if (state.view === 'log') await loadLog(true);
  } catch (err) {
    toast(err.message, true);
  } finally {
    updateCommitCount();
  }
}

function rememberCommitMessage(message) {
  const msg = (message || '').trim();
  if (!msg) return;
  const history = [msg, ...(state.settings.commitHistory || []).filter((m) => m !== msg)].slice(0, 25);
  state.settings.commitHistory = history;
  window.api.setSettings({ commitHistory: history }).catch(() => {});
}

async function doPush() {
  try {
    statusMsg('Pushing…');
    const out = await window.api.gitPush();
    statusMsg('');
    toast(out.trim() ? out.trim().split('\n').pop() : 'Pushed');
  } catch (err) {
    statusMsg('');
    toast('Push failed: ' + err.message, true);
  }
}

async function doRollback() {
  const row = selectedRow();
  if (!row) return;
  const files = row.kind === 'file' ? [row.file] : collectFiles(row.node);
  if (!files.length) return;
  const names = files.length === 1 ? files[0].path : `${files.length} files`;
  const ok = await window.api.confirm({
    message: `Rollback ${names}?`,
    detail: 'Local changes will be reverted to the repository version. Unversioned files will be deleted.',
    confirmLabel: 'Rollback',
  });
  if (!ok) return;
  try {
    if (state.current && files.some((f) => f.path === state.current.path)) {
      setDirty(false); // don't autosave what we're about to revert
    }
    await window.api.gitRollback(files.map((f) => ({ path: f.path, type: f.type, origPath: f.origPath })));
    toast(`Rolled back ${names}`);
    await refreshStatus();
  } catch (err) {
    toast('Rollback failed: ' + err.message, true);
  }
}

async function doPull() {
  try {
    statusMsg('Pulling…');
    const out = await window.api.gitPull();
    statusMsg('');
    toast(out.trim() ? out.trim().split('\n').pop() : 'Pulled');
    await refreshStatus();
    if (state.view === 'log') await loadLog(true);
  } catch (err) {
    statusMsg('');
    toast('Pull failed: ' + err.message, true);
  }
}

async function doFetch() {
  try {
    statusMsg('Fetching…');
    await window.api.gitFetch();
    statusMsg('');
    toast('Fetched');
    await refreshStatus();
  } catch (err) {
    statusMsg('');
    toast('Fetch failed: ' + err.message, true);
  }
}
