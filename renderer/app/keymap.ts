'use strict';

/* Keybinding state, normalization, and event matching.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

// ------------------------------------------------------------------ keymap

const IS_MAC = /Mac/i.test(navigator.platform);
const KEYMAP_ACTIONS: KeymapAction[] = window.api.keymapActions || [];
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
type Mod = (typeof MOD_ORDER)[number];

interface KeymapUiState {
  overrides: KeymapOverrides; // actionId -> binding string | null (unbound)
  bindings: Map<ActionId, string | null>; // actionId -> normalized binding | null
  byBinding: Map<string, ActionId>; // normalized binding -> actionId
  recordingAction: ActionId | null; // actionId while capturing a new shortcut
  dialogOpen: boolean;
}

const km: KeymapUiState = {
  overrides: {},
  bindings: new Map(),
  byBinding: new Map(),
  recordingAction: null,
  dialogOpen: false,
};

function kmDefault(id: ActionId): Binding {
  const a = KEYMAP_ACTIONS.find((x) => x.id === id);
  return a ? a.default : null;
}

function kmRaw(id: ActionId): Binding {
  return Object.prototype.hasOwnProperty.call(km.overrides, id)
    ? km.overrides[id] ?? null
    : kmDefault(id);
}

// Same normalization as main/keymap.ts: Mod resolved per platform, modifiers
// in canonical order, single letters uppercased.
function normalizeBinding(binding: Binding): string | null {
  if (!binding) return null;
  const parts = binding.split('+');
  let key = parts.pop()!;
  if (key.length === 1) key = key.toUpperCase();
  const mods = new Set<Mod>(parts.map((m) => (m === 'Mod' ? (IS_MAC ? 'Meta' : 'Ctrl') : (m as Mod))));
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

function rebuildKeymap(): void {
  km.bindings.clear();
  km.byBinding.clear();
  for (const a of KEYMAP_ACTIONS) {
    const norm = normalizeBinding(kmRaw(a.id));
    km.bindings.set(a.id, norm);
    if (norm) km.byBinding.set(norm, a.id);
  }
  updateShortcutHints();
}

function prettyBinding(norm: string | null): string {
  if (!norm) return 'None';
  const SYM: Record<string, string> = IS_MAC
    ? { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }
    : { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Super' };
  const KEY: Record<string, string> = {
    Escape: 'Esc', Enter: IS_MAC ? '⏎' : 'Enter', Space: 'Space',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  };
  const parts = norm.split('+');
  const key = parts.pop()!;
  const mods = parts.map((m) => SYM[m]);
  const shown = KEY[key] || key;
  return IS_MAC ? mods.join('') + shown : [...mods, shown].join('+');
}

function actionShortcut(id: ActionId): string {
  return prettyBinding(km.bindings.get(id) ?? null);
}

function updateShortcutHints(): void {
  const hint = (id: ActionId) => {
    const s = actionShortcut(id);
    return s === 'None' ? '' : ` (${s})`;
  };
  $('btn-next-diff').title = 'Next Difference' + hint('next-diff');
  $('btn-prev-diff').title = 'Previous Difference' + hint('prev-diff');
  $('btn-next-file').title = 'Next Changed File' + hint('next-file');
  $('btn-prev-file').title = 'Previous Changed File' + hint('prev-file');
  $('btn-commit').title = 'Commit' + hint('commit-execute');
  $('btn-commit-push').title = 'Commit and Push' + hint('commit-and-push');
  $('btn-refresh').title = 'Refresh File Status' + hint('refresh');
  $('btn-rollback').title = 'Rollback…' + hint('rollback');
  $('btn-keymap').title = 'Settings' + hint('keymap-settings');
  $('btn-stash').title = 'Stash / Unstash…' + hint('stash');
  $('btn-blame').title = 'Blame Annotations' + hint('annotate');
  $('btn-msg-history').title = 'Commit Message History' + hint('commit-history');
  $('tab-log').title = 'Log' + hint('toggle-log');
  $<HTMLInputElement>('tree-filter').placeholder = 'Filter changes…' +
    (actionShortcut('filter') === 'None' ? '' : ` (${actionShortcut('filter')})`);
  $('status-branch').title = 'Branches' + hint('branches');
}

// Layout-stable key name from a keyboard event (e.key for shifted
// punctuation varies — ⌘⇧] reports key '}' — so punctuation and letters come
// from e.code, matching how Electron accelerators are interpreted).
const CODE_KEYS: Record<string, string> = {
  BracketRight: ']', BracketLeft: '[', Comma: ',', Period: '.', Slash: '/',
  Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`', Minus: '-',
  Equal: '=', Enter: 'Enter', NumpadEnter: 'Enter', Space: 'Space',
  Escape: 'Escape',
};

function eventToBinding(e: KeyboardEvent): string | null {
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return null;
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code]!;
  else if (/^F\d+$/.test(e.key)) key = e.key;
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  return [...mods, key].join('+');
}

function inEditableContext(): boolean {
  const el = document.activeElement;
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || (el as HTMLElement).isContentEditable);
}

// While typing, only chords with a real modifier — or F-keys / Escape — may
// trigger actions; bare printable keys are text input.
function bindingAllowedHere(norm: string): boolean {
  if (!inEditableContext()) return true;
  const parts = norm.split('+');
  const key = parts.pop()!;
  if (parts.some((m) => m !== 'Shift')) return true;
  return /^F\d+$/.test(key) || key === 'Escape';
}

async function saveKeymap(): Promise<void> {
  rebuildKeymap();
  try {
    await window.api.setKeymap(km.overrides); // persists + rebuilds app menu
  } catch (err) {
    toast('Failed to save keymap: ' + errMsg(err), true);
  }
}
