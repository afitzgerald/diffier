'use strict';

/* What's New dialog: release notes baked into the build (main/whats-new.ts),
   shown once after an update and from Help → What's New.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

let whatsNewOpen = false;

// unseen: the launch check — only what's new since the last version shown,
// and nothing at all if that's this one.
async function openWhatsNew(unseen: boolean): Promise<void> {
  let releases: WhatsNewRelease[];
  try {
    releases = await window.api.getWhatsNew(unseen);
  } catch (err) {
    if (!unseen) toast("Failed to load What's New: " + errMsg(err), true);
    return;
  }
  if (!releases.length) return;
  const body = $('whatsnew-body');
  body.replaceChildren();
  $('whatsnew-title').textContent =
    releases.length === 1 ? `What's New in ${releases[0].version}` : "What's New";
  for (const r of releases) {
    if (releases.length > 1) body.appendChild(whatsNewEl('h3', 'whatsnew-version', `Version ${r.version}`));
    for (const s of r.sections) {
      if (s.title) body.appendChild(whatsNewEl('h4', 'whatsnew-section', s.title));
      const ul = body.appendChild(whatsNewEl('ul', '', ''));
      for (const item of s.items) ul.appendChild(noteItem(item));
    }
  }
  whatsNewOpen = true;
  $('whatsnew-overlay').classList.remove('hidden');
}

function whatsNewEl(tag: string, cls: string, text: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.textContent = text;
  return e;
}

// A PR title, as text: `backticks` become <code>, nothing else is markup.
function noteItem(item: string): HTMLElement {
  const li = whatsNewEl('li', '', '');
  item.split('`').forEach((part, i) => li.appendChild(i % 2 ? whatsNewEl('code', '', part) : document.createTextNode(part)));
  return li;
}

function closeWhatsNew(): void {
  whatsNewOpen = false;
  $('whatsnew-overlay').classList.add('hidden');
  treeEl.focus();
}

$('whatsnew-done').addEventListener('click', closeWhatsNew);
$('whatsnew-overlay').addEventListener('mousedown', (e) => {
  if (e.target === $('whatsnew-overlay')) closeWhatsNew();
});
