'use strict';

/* Popup infrastructure, branch popup, message history, repo switcher, context menu.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

// ------------------------------------------------------------------ popups

const POPUP_IDS = ['branch-popup', 'msg-history-popup', 'repo-popup', 'context-menu'];
// popupId -> anchorId, filled by registerPopup(). A popup's own anchor must
// not close it on mousedown — otherwise the anchor's click handler sees a
// closed popup and immediately reopens it, making toggle-off impossible.
const POPUP_ANCHORS: Record<string, string> = {};

// Wire an anchored popup: the anchor click toggles it, and the global
// mousedown-closer leaves the anchor alone so the toggle actually closes.
// Every anchored popup must go through this — never hand-wire the toggle.
function registerPopup(popupId: string, anchorId: string, openFn: () => void): void {
  POPUP_ANCHORS[popupId] = anchorId;
  $(anchorId).addEventListener('click', () => {
    if ($(popupId).classList.contains('hidden')) openFn();
    else closePopups();
  });
}

function closePopups(): void {
  for (const id of POPUP_IDS) $(id).classList.add('hidden');
}

function anyPopupOpen(): boolean {
  return POPUP_IDS.some((id) => !$(id).classList.contains('hidden'));
}

window.addEventListener(
  'mousedown',
  (e) => {
    if (!anyPopupOpen()) return;
    for (const id of POPUP_IDS) {
      const el = $(id);
      if (el.classList.contains('hidden') || el.contains(e.target as Node)) continue;
      const anchor = POPUP_ANCHORS[id] && $(POPUP_ANCHORS[id]!);
      if (anchor && anchor.contains(e.target as Node)) continue;
      el.classList.add('hidden');
    }
  },
  true
);

interface PositionPopupOptions {
  anchor: HTMLElement;
  align: 'above-right' | 'below' | 'above-left';
}

function positionPopup(el: HTMLElement, opts: PositionPopupOptions): void {
  el.classList.remove('hidden');
  const { anchor, align } = opts;
  const r = anchor.getBoundingClientRect();
  el.style.left = el.style.right = el.style.top = el.style.bottom = 'auto';
  if (align === 'above-right') {
    el.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    el.style.bottom = window.innerHeight - r.top + 6 + 'px';
  } else if (align === 'below') {
    el.style.left = Math.min(r.left, window.innerWidth - el.offsetWidth - 8) + 'px';
    el.style.top = r.bottom + 6 + 'px';
  } else if (align === 'above-left') {
    el.style.left = Math.min(r.left, window.innerWidth - el.offsetWidth - 8) + 'px';
    el.style.bottom = window.innerHeight - r.top + 6 + 'px';
  }
}

interface PopupItemOptions {
  section?: boolean;
  icon?: string;
  title?: string;
  detail?: string;
  onClick?: () => void;
}

function popupItem(label: string, opts: PopupItemOptions = {}): HTMLElement {
  const item = document.createElement('div');
  item.className = 'popup-item' + (opts.section ? ' section' : '');
  if (opts.icon) {
    const ic = document.createElement('span');
    ic.textContent = opts.icon;
    item.appendChild(ic);
  }
  const lbl = document.createElement('span');
  lbl.className = 'item-label';
  lbl.textContent = label;
  if (opts.title) item.title = opts.title;
  item.appendChild(lbl);
  if (opts.detail) {
    const d = document.createElement('span');
    d.className = 'dim';
    d.textContent = opts.detail;
    item.appendChild(d);
  }
  if (opts.onClick) {
    item.addEventListener('click', () => {
      closePopups();
      opts.onClick!();
    });
  }
  return item;
}

// ------------------------------------------------------------ branch popup

interface BranchListItem {
  el: HTMLElement;
  action: () => void;
}

interface BranchUiState {
  branches: BranchesResult | null;
  active: number;
  items: BranchListItem[];
}

const branchState: BranchUiState = { branches: null, active: 0, items: [] };

async function openBranchPopup(): Promise<void> {
  if (!state.repo) return;
  let br: BranchesResult;
  try {
    br = await window.api.gitBranches();
  } catch (err) {
    toast('Failed to list branches: ' + errMsg(err), true);
    return;
  }
  branchState.branches = br;
  branchState.active = 0;
  const popup = $('branch-popup');
  $<HTMLInputElement>('branch-filter').value = '';
  renderBranchList();
  positionPopup(popup, { anchor: $('status-branch'), align: 'above-right' });
  $('branch-filter').focus();
}

function renderBranchList(): void {
  const q = $<HTMLInputElement>('branch-filter').value.trim().toLowerCase();
  const br = branchState.branches!;
  const list = $('branch-list');
  list.textContent = '';
  branchState.items = [];

  const addItem = (el: HTMLElement, action: () => void) => {
    el.dataset.idx = String(branchState.items.length);
    if (branchState.items.length === branchState.active) el.classList.add('active');
    el.addEventListener('click', () => {
      closePopups();
      action();
    });
    branchState.items.push({ el, action });
    list.appendChild(el);
  };

  const locals = br.locals.filter((b) => !q || b.name.toLowerCase().includes(q));
  const remotes = br.remotes.filter((n) => !q || n.toLowerCase().includes(q));

  const newName = $<HTMLInputElement>('branch-filter').value.trim();
  const exact = br.locals.some((b) => b.name === newName);
  if (newName && !exact && /^[^\s~^:?*[\\]+$/.test(newName)) {
    const el = popupItem(`Create branch “${newName}”`, { icon: '＋' });
    addItem(el, () => checkoutBranch(newName, true));
  }

  if (locals.length) list.appendChild(popupItem('Local branches', { section: true }));
  for (const b of locals) {
    const el = popupItem(b.name, {
      icon: b.current ? '✓' : '⎇',
      detail: b.track ? b.track.replace(/[[\]]/g, '') : '',
      title: b.upstream ? `Upstream: ${b.upstream}` : '',
    });
    addItem(el, () => {
      if (!b.current) checkoutBranch(b.name, false);
    });
  }
  if (remotes.length) list.appendChild(popupItem('Remote branches', { section: true }));
  for (const name of remotes.slice(0, 50)) {
    const local = name.split('/').slice(1).join('/');
    const el = popupItem(name, { icon: '☁', title: `Checkout as “${local}”` });
    addItem(el, () => checkoutBranch(local, false));
  }
  if (!branchState.items.length) {
    list.appendChild(popupItem('No matching branches', { section: true }));
  }
}

async function checkoutBranch(name: string, create: boolean): Promise<void> {
  await autosaveIfDirty();
  try {
    statusMsg((create ? 'Creating ' : 'Checking out ') + name + '…');
    if (create) await window.api.gitCreateBranch(name);
    else await window.api.gitCheckout(name);
    statusMsg('');
    toast((create ? 'Created branch ' : 'Switched to ') + name);
    await refreshStatus();
    if (state.view === 'log') await loadLog(true);
  } catch (err) {
    statusMsg('');
    toast('Checkout failed: ' + errMsg(err), true);
  }
}

$('branch-filter').addEventListener('input', () => {
  branchState.active = 0;
  renderBranchList();
});
$('branch-filter').addEventListener('keydown', (e) => {
  const items = branchState.items;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    if (!items.length) return;
    branchState.active =
      (branchState.active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items.forEach((it, i) => it.el.classList.toggle('active', i === branchState.active));
    items[branchState.active]!.el.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey) {
      const name = $<HTMLInputElement>('branch-filter').value.trim();
      if (name) {
        closePopups();
        checkoutBranch(name, true);
      }
      return;
    }
    const it = items[branchState.active];
    if (it) {
      closePopups();
      it.action();
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closePopups();
    treeEl.focus();
  }
});
registerPopup('branch-popup', 'status-branch', openBranchPopup);

// ----------------------------------------------------- commit msg history

function openMsgHistory(): void {
  const history = state.settings.commitHistory || [];
  const list = $('msg-history-list');
  list.textContent = '';
  if (!history.length) {
    const empty = document.createElement('div');
    empty.className = 'stash-empty';
    empty.textContent = 'No previous commit messages';
    list.appendChild(empty);
  }
  for (const msg of history) {
    const item = popupItem(msg.length > 300 ? msg.slice(0, 300) + '…' : msg, {
      title: msg,
      onClick: () => {
        $<HTMLTextAreaElement>('commit-message').value = msg;
        updateSubjectLength();
        $('commit-message').focus();
      },
    });
    item.classList.add('msg-history-item');
    list.appendChild(item);
  }
  positionPopup($('msg-history-popup'), { anchor: $('commit-message'), align: 'above-left' });
}

function toggleMsgHistory(): void {
  if ($('msg-history-popup').classList.contains('hidden')) openMsgHistory();
  else closePopups();
}
registerPopup('msg-history-popup', 'btn-msg-history', openMsgHistory);

function updateSubjectLength(): void {
  const subject = ($<HTMLTextAreaElement>('commit-message').value.split('\n')[0] || '').length;
  const el = $('subject-length');
  el.textContent = subject ? String(subject) : '';
  el.classList.toggle('warn', subject > 50 && subject <= 72);
  el.classList.toggle('over', subject > 72);
  el.title = 'Subject line length — aim for ≤50, hard-wrap at 72';
}

$('commit-message').addEventListener('input', updateSubjectLength);

// ------------------------------------------------------------ repo popup

function openRepoPopup(): void {
  const list = $('repo-list');
  list.textContent = '';
  const recents = (state.repo && state.repo.recents) || state.settings.recentRepos || [];
  if (recents.length) list.appendChild(popupItem('Recent repositories', { section: true }));
  for (const dir of recents) {
    const name = dir.split('/').pop()!;
    const el = popupItem(name, {
      icon: state.repo && state.repo.root === dir ? '✓' : '▸',
      detail: dir,
      title: dir,
    });
    el.addEventListener('click', async () => {
      closePopups();
      if (state.repo && state.repo.root === dir) return;
      try {
        const repo = await window.api.openRepo(dir);
        if (repo) await setRepo(repo);
      } catch (err) {
        toast(errMsg(err), true);
      }
    });
    list.appendChild(el);
  }
  const sep = document.createElement('div');
  sep.className = 'popup-sep';
  list.appendChild(sep);
  list.appendChild(popupItem('Open Repository…', { icon: '📂', onClick: () => openRepoDialog() }));
  positionPopup($('repo-popup'), { anchor: $('titlebar-repo'), align: 'below' });
}

registerPopup('repo-popup', 'titlebar-repo', openRepoPopup);

// ------------------------------------------------------------ context menu

function openFileContextMenu(e: MouseEvent, file: FileEntry): void {
  const menu = $('context-menu');
  menu.textContent = '';
  menu.appendChild(
    popupItem('Show History', { icon: '🕘', onClick: () => showFileHistory(file.path) })
  );
  menu.appendChild(
    popupItem('Show Blame', {
      icon: '👤',
      onClick: () => {
        if (!state.blameOn) toggleBlame();
      },
    })
  );
  const sep1 = document.createElement('div');
  sep1.className = 'popup-sep';
  menu.appendChild(sep1);
  menu.appendChild(popupItem('Rollback…', { icon: '↩', onClick: () => doRollback() }));
  const sep2 = document.createElement('div');
  sep2.className = 'popup-sep';
  menu.appendChild(sep2);
  menu.appendChild(
    popupItem('Copy Path', {
      icon: '📋',
      onClick: () => {
        navigator.clipboard.writeText(file.path).catch(() => {});
      },
    })
  );
  menu.appendChild(
    popupItem('Reveal in Finder', {
      icon: '📁',
      onClick: () => {
        window.api.revealFile(file.path).catch(() => {});
      },
    })
  );
  menu.classList.remove('hidden');
  menu.style.right = menu.style.bottom = 'auto';
  menu.style.left = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8) + 'px';
}

function openDirContextMenu(e: MouseEvent, dirPath: string): void {
  const menu = $('context-menu');
  menu.textContent = '';
  menu.appendChild(
    popupItem('Copy Path', {
      icon: '📋',
      onClick: () => {
        navigator.clipboard.writeText(dirPath).catch(() => {});
      },
    })
  );
  menu.appendChild(
    popupItem('Reveal in Finder', {
      icon: '📁',
      onClick: () => {
        window.api.revealFile(dirPath).catch(() => {});
      },
    })
  );
  menu.classList.remove('hidden');
  menu.style.right = menu.style.bottom = 'auto';
  menu.style.left = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8) + 'px';
}
