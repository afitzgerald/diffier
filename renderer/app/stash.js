'use strict';

/* Stash dialog.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

/* global monaco */

// ------------------------------------------------------------------ stash

let stashOpen = false;

async function renderStashList() {
  const list = $('stash-list');
  let stashes = [];
  try {
    stashes = await window.api.gitStashList();
  } catch (err) {
    toast('Failed to list stashes: ' + err.message, true);
  }
  list.textContent = '';
  if (!stashes.length) {
    const empty = document.createElement('div');
    empty.className = 'stash-empty';
    empty.textContent = 'No stashes';
    list.appendChild(empty);
    return;
  }
  for (const s of stashes) {
    const row = document.createElement('div');
    row.className = 'stash-row';
    const ref = document.createElement('span');
    ref.className = 'dim';
    ref.textContent = s.ref;
    row.appendChild(ref);
    const msg = document.createElement('span');
    msg.className = 'stash-msg';
    msg.textContent = s.message;
    msg.title = s.message + (s.time ? ` — ${new Date(s.time).toLocaleString()}` : '');
    row.appendChild(msg);
    const actions = document.createElement('span');
    actions.className = 'stash-actions';
    const mk = (label, fn, title) => {
      const b = document.createElement('button');
      b.className = 'icon-btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };
    mk('Pop', () => doStashOp('pop', s.ref), 'Apply and drop this stash');
    mk('Apply', () => doStashOp('apply', s.ref), 'Apply, keep the stash');
    mk('Drop', async () => {
      const ok = await window.api.confirm({
        message: `Drop ${s.ref}?`,
        detail: s.message,
        confirmLabel: 'Drop',
      });
      if (ok) doStashOp('drop', s.ref);
    }, 'Delete this stash');
    row.appendChild(actions);
    list.appendChild(row);
  }
}

async function doStashOp(op, ref) {
  try {
    if (op === 'pop') await window.api.gitStashPop(ref);
    else if (op === 'apply') await window.api.gitStashApply(ref);
    else if (op === 'drop') await window.api.gitStashDrop(ref);
    toast(`Stash ${op}: ${ref}`);
    await renderStashList();
    await refreshStatus();
  } catch (err) {
    toast(`Stash ${op} failed: ` + err.message, true);
  }
}

async function doStashPush() {
  await autosaveIfDirty();
  try {
    await window.api.gitStashPush($('stash-message').value, $('stash-untracked').checked);
    $('stash-message').value = '';
    toast('Stashed changes');
    await renderStashList();
    await refreshStatus();
  } catch (err) {
    toast('Stash failed: ' + err.message, true);
  }
}

function openStashDialog() {
  if (!state.repo) return;
  stashOpen = true;
  $('stash-overlay').classList.remove('hidden');
  renderStashList();
  $('stash-message').focus();
}

function closeStashDialog() {
  stashOpen = false;
  $('stash-overlay').classList.add('hidden');
  treeEl.focus();
}

$('btn-stash').addEventListener('click', openStashDialog);
$('btn-stash-push').addEventListener('click', doStashPush);
$('stash-done').addEventListener('click', closeStashDialog);
$('stash-overlay').addEventListener('mousedown', (e) => {
  if (e.target === $('stash-overlay')) closeStashDialog();
});
$('stash-message').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doStashPush();
  }
});
