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

// ------------------------------------------------------- acknowledgements

let acknowledgementsOpen = false;

// LICENSE and THIRD_PARTY_NOTICES.md as plain monospace text: mostly license
// texts, which read fine raw.
async function openAcknowledgements(): Promise<void> {
  try {
    $('ack-body').textContent = await window.api.getAcknowledgements();
  } catch (err) {
    toast('Failed to load acknowledgements: ' + errMsg(err), true);
    return;
  }
  acknowledgementsOpen = true;
  $('ack-overlay').classList.remove('hidden');
  $('ack-body').scrollTop = 0;
}

function closeAcknowledgements(): void {
  acknowledgementsOpen = false;
  $('ack-overlay').classList.add('hidden');
  treeEl.focus();
}

$('about-acknowledgements').addEventListener('click', (e) => {
  e.preventDefault();
  closeAboutDialog();
  void openAcknowledgements();
});
$('ack-done').addEventListener('click', closeAcknowledgements);
$('ack-overlay').addEventListener('mousedown', (e) => {
  if (e.target === $('ack-overlay')) closeAcknowledgements();
});
