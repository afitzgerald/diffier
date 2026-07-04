'use strict';

/* Stash dialog.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

// ------------------------------------------------------------------ stash

let stashOpen = false;

async function renderStashList(): Promise<void> {
  const list = $('stash-list');
  let stashes: StashEntry[] = [];
  try {
    stashes = await window.api.gitStashList();
  } catch (err) {
    toast('Failed to list stashes: ' + errMsg(err), true);
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
    const mk = (label: string, fn: (e: MouseEvent) => void, title: string) => {
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

type StashOp = 'pop' | 'apply' | 'drop';

async function doStashOp(op: StashOp, ref: string): Promise<void> {
  try {
    if (op === 'pop') await window.api.gitStashPop(ref);
    else if (op === 'apply') await window.api.gitStashApply(ref);
    else if (op === 'drop') await window.api.gitStashDrop(ref);
    toast(`Stash ${op}: ${ref}`);
    await renderStashList();
    await refreshStatus();
  } catch (err) {
    toast(`Stash ${op} failed: ` + errMsg(err), true);
  }
}

async function doStashPush(): Promise<void> {
  await autosaveIfDirty();
  try {
    await window.api.gitStashPush(
      $<HTMLInputElement>('stash-message').value,
      $<HTMLInputElement>('stash-untracked').checked
    );
    $<HTMLInputElement>('stash-message').value = '';
    toast('Stashed changes');
    await renderStashList();
    await refreshStatus();
  } catch (err) {
    toast('Stash failed: ' + errMsg(err), true);
  }
}

function openStashDialog(): void {
  if (!state.repo) return;
  stashOpen = true;
  $('stash-overlay').classList.remove('hidden');
  renderStashList();
  $('stash-message').focus();
}

function closeStashDialog(): void {
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
