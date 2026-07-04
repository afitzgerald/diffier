'use strict';

/*
 * Keymap definitions shared by the main process (menu accelerators) and the
 * renderer (keydown matching, settings dialog).
 *
 * Bindings are stored as strings like "F7", "Shift+F7", "Alt+Mod+Enter".
 * "Mod" is a platform pseudo-modifier: Cmd on macOS, Ctrl elsewhere. Defaults
 * use it so one keymap reads naturally on both platforms; user-recorded
 * bindings store the concrete modifiers that were pressed. A null binding
 * means the action is unbound.
 */

const ACTIONS = [
  { id: 'next-diff', label: 'Next Difference', default: 'F7' },
  { id: 'prev-diff', label: 'Previous Difference', default: 'Shift+F7' },
  { id: 'next-file', label: 'Next Changed File', default: 'Mod+Shift+]' },
  { id: 'prev-file', label: 'Previous Changed File', default: 'Mod+Shift+[' },
  { id: 'focus-tree', label: 'Focus Changes Tree', default: 'Escape' },
  { id: 'commit', label: 'Commit (Focus Message)', default: 'Mod+K' },
  { id: 'commit-execute', label: 'Commit Checked Files', default: 'Mod+Enter' },
  { id: 'commit-and-push', label: 'Commit and Push', default: 'Alt+Mod+Enter' },
  { id: 'commit-history', label: 'Commit Message History', default: 'Mod+E' },
  { id: 'push', label: 'Push', default: 'Mod+Shift+K' },
  { id: 'pull', label: 'Pull', default: 'Mod+T' },
  { id: 'fetch', label: 'Fetch', default: null },
  { id: 'branches', label: 'Branches Popup', default: 'Mod+B' },
  { id: 'stash', label: 'Stash / Unstash', default: null },
  { id: 'rollback', label: 'Rollback Selected', default: 'Alt+Mod+Z' },
  { id: 'toggle-log', label: 'Log Tool Window', default: 'Mod+9' },
  { id: 'filter', label: 'Filter Changes', default: 'Mod+Shift+F' },
  { id: 'annotate', label: 'Toggle Blame Annotations', default: null },
  { id: 'save', label: 'Save File', default: 'Mod+S' },
  { id: 'open-repo', label: 'Open Repository', default: 'Mod+O' },
  { id: 'refresh', label: 'Refresh File Status', default: 'Mod+R' },
  { id: 'toggle-panel', label: 'Commit Tool Window', default: 'Mod+0' },
  { id: 'keymap-settings', label: 'Settings', default: 'Mod+,' },
];

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];

// Effective bindings: defaults overlaid with user overrides. An override of
// null explicitly unbinds the action.
function effective(overrides) {
  const map = {};
  for (const a of ACTIONS) {
    map[a.id] =
      overrides && Object.prototype.hasOwnProperty.call(overrides, a.id)
        ? overrides[a.id]
        : a.default;
  }
  return map;
}

// Canonical form used for matching: Mod resolved to the platform modifier,
// modifiers sorted, single letters uppercased. "Alt+Mod+Enter" on macOS
// becomes "Alt+Meta+Enter".
function normalize(binding, isMac) {
  if (!binding) return null;
  const parts = binding.split('+');
  let key = parts.pop();
  if (key.length === 1) key = key.toUpperCase();
  const mods = new Set(
    parts.map((m) => (m === 'Mod' ? (isMac ? 'Meta' : 'Ctrl') : m))
  );
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

const ACCEL_KEYS = {
  Enter: 'Return',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

// Convert a binding to an Electron menu accelerator, or null when the
// binding must stay renderer-only: Escape (a registered Escape accelerator
// would swallow every Esc press app-wide) and bare printable keys (they
// would fire while the user types in the commit message).
function toAccelerator(binding, platform) {
  if (!binding) return null;
  const parts = binding.split('+');
  const key = parts.pop();
  if (key === 'Escape') return null;
  const hasRealMod = parts.some((m) => m !== 'Shift');
  if (!hasRealMod && !/^F\d+$/.test(key)) return null;
  const mods = parts.map((m) => {
    if (m === 'Mod') return 'CommandOrControl';
    if (m === 'Meta') return platform === 'darwin' ? 'Cmd' : 'Super';
    return m; // Ctrl, Alt, Shift
  });
  const accelKey = ACCEL_KEYS[key] || (key.length === 1 ? key.toUpperCase() : key);
  return [...mods, accelKey].join('+');
}

// Human-readable form for menu label hints on accelerator-less bindings.
function describe(binding, isMac) {
  if (!binding) return '';
  const SYM = isMac
    ? { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘', Mod: '⌘' }
    : { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Super', Mod: 'Ctrl' };
  const KEY = { Escape: 'Esc', Enter: isMac ? '⏎' : 'Enter', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space' };
  const parts = binding.split('+');
  const key = parts.pop();
  const mods = parts.map((m) => SYM[m] || m);
  const shown = KEY[key] || key;
  return isMac ? mods.join('') + shown : [...mods, shown].join('+');
}

module.exports = { ACTIONS, effective, normalize, toAccelerator, describe };
