'use strict';

/* Settings dialog: theme picker, panel-side picker, and keymap editor.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

// ------------------------------------------------------------- panel side

function applyPanelSide(side: 'left' | 'right'): void {
  document.body.classList.toggle('panel-right', side === 'right');
  const sel = $<HTMLSelectElement>('panel-side-select');
  if (sel.value !== side) sel.value = side;
}

// ------------------------------------------------------------ keymap dialog

function renderKeymapDialog(): void {
  const list = $('keymap-list');
  list.textContent = '';
  for (const a of KEYMAP_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'keymap-row';
    row.dataset.action = a.id;

    const label = document.createElement('span');
    label.className = 'keymap-label';
    label.textContent = a.label;
    row.appendChild(label);

    const overridden = Object.prototype.hasOwnProperty.call(km.overrides, a.id);

    if (overridden) {
      const marker = document.createElement('button');
      marker.className = 'icon-btn overridden-marker';
      marker.textContent = '↺';
      marker.title = `Reset to default (${prettyBinding(normalizeBinding(a.default))})`;
      marker.addEventListener('click', () => {
        delete km.overrides[a.id];
        saveKeymap();
        renderKeymapDialog();
      });
      row.appendChild(marker);
    }

    const clear = document.createElement('button');
    clear.className = 'icon-btn';
    clear.textContent = '✕';
    clear.title = 'Remove shortcut';
    clear.addEventListener('click', () => {
      km.overrides[a.id] = null;
      saveKeymap();
      renderKeymapDialog();
    });
    row.appendChild(clear);

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'keymap-shortcut';
    const norm = km.bindings.get(a.id) ?? null;
    if (km.recordingAction === a.id) {
      chip.classList.add('recording');
      chip.textContent = 'Press shortcut…';
    } else if (!norm) {
      chip.classList.add('unbound');
      chip.textContent = 'None';
    } else {
      chip.textContent = prettyBinding(norm);
    }
    chip.title = km.recordingAction === a.id ? 'Press the new shortcut' : 'Record a shortcut';
    chip.addEventListener('click', () => {
      km.recordingAction = km.recordingAction === a.id ? null : a.id;
      renderKeymapDialog();
    });
    row.appendChild(chip);

    list.appendChild(row);
  }
}

function assignBinding(actionId: ActionId, binding: string): void {
  const norm = normalizeBinding(binding);
  // Steal the shortcut from whichever action currently holds it.
  const holder = norm ? km.byBinding.get(norm) : undefined;
  if (holder && holder !== actionId) {
    km.overrides[holder] = null;
    const held = KEYMAP_ACTIONS.find((x) => x.id === holder);
    toast(`${prettyBinding(norm)} removed from “${held ? held.label : holder}”`);
  }
  // Store the default itself as "no override".
  if (normalizeBinding(kmDefault(actionId)) === norm) delete km.overrides[actionId];
  else km.overrides[actionId] = norm;
  km.recordingAction = null;
  saveKeymap();
  renderKeymapDialog();
}

function stopRecording(): void {
  km.recordingAction = null;
  renderKeymapDialog();
}

function openKeymapDialog(): void {
  km.dialogOpen = true;
  $('keymap-overlay').classList.remove('hidden');
  renderKeymapDialog();
}

function closeKeymapDialog(): void {
  km.dialogOpen = false;
  km.recordingAction = null;
  $('keymap-overlay').classList.add('hidden');
  treeEl.focus();
}

function toggleKeymapDialog(): void {
  if (km.dialogOpen) closeKeymapDialog();
  else openKeymapDialog();
}

$('btn-keymap').addEventListener('click', openKeymapDialog);
(() => {
  const sel = $<HTMLSelectElement>('theme-select');
  for (const t of Object.values(THEMES)) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.label;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => setTheme(sel.value as ThemeId));
})();
(() => {
  const wire = (
    id: string,
    settingsKey: 'wordWrap' | 'ignoreWhitespace' | 'collapseUnchanged',
    toolbarBtnId: string,
    applyToEditor: (on: boolean) => void
  ): void => {
    const box = $<HTMLInputElement>(id);
    box.addEventListener('change', async () => {
      const on = box.checked;
      state.settings[settingsKey] = on;
      window.api.setSettings({ [settingsKey]: on }).catch(() => {});
      $(toolbarBtnId).classList.toggle('active', on);
      await monacoReady;
      applyToEditor(on);
    });
  };
  wire('default-word-wrap', 'wordWrap', 'btn-word-wrap', (on) =>
    diffEditor!.updateOptions({ diffWordWrap: on ? 'on' : 'off' })
  );
  wire('default-ignore-whitespace', 'ignoreWhitespace', 'btn-whitespace', (on) =>
    diffEditor!.updateOptions({ ignoreTrimWhitespace: on })
  );
  wire('default-collapse-unchanged', 'collapseUnchanged', 'btn-collapse-unchanged', (on) =>
    diffEditor!.updateOptions({ hideUnchangedRegions: { enabled: on } })
  );
})();
(() => {
  const sel = $<HTMLSelectElement>('panel-side-select');
  sel.addEventListener('change', () => {
    const side = sel.value === 'right' ? 'right' : 'left';
    applyPanelSide(side);
    state.settings.panelSide = side;
    window.api.setSettings({ panelSide: side }).catch(() => {});
  });
})();
$('keymap-done').addEventListener('click', closeKeymapDialog);
$('keymap-reset-all').addEventListener('click', () => {
  km.overrides = {};
  km.recordingAction = null;
  saveKeymap();
  renderKeymapDialog();
});
$('keymap-overlay').addEventListener('mousedown', (e) => {
  if (e.target === $('keymap-overlay')) closeKeymapDialog();
});
