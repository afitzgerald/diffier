'use strict';

/* About dialog: app identity, version, and license info.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

let aboutOpen = false;
let aboutInfoLoaded = false;

async function openAboutDialog(): Promise<void> {
  aboutOpen = true;
  $('about-overlay').classList.remove('hidden');
  if (!aboutInfoLoaded) {
    try {
      const info = await window.api.getAppInfo();
      $('about-version').textContent = `Version ${info.version}`;
      aboutInfoLoaded = true;
    } catch (err) {
      toast('Failed to load app info: ' + errMsg(err), true);
    }
  }
}

function closeAboutDialog(): void {
  aboutOpen = false;
  $('about-overlay').classList.add('hidden');
  treeEl.focus();
}

function toggleAboutDialog(): void {
  if (aboutOpen) closeAboutDialog();
  else void openAboutDialog();
}

$('about-done').addEventListener('click', closeAboutDialog);
$('about-overlay').addEventListener('mousedown', (e) => {
  if (e.target === $('about-overlay')) closeAboutDialog();
});
