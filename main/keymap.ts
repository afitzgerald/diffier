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

import type { ActionId, Binding, KeymapAction, KeymapOverrides } from './keymap-types';
import { ACTIONS } from './keymap-types';

// Re-exported so existing `import {...} from './keymap'` call sites (main
// process, tests) keep working — see keymap-types.ts for why the pure data
// lives in a separate file.
export type { ActionId, Binding, KeymapAction, KeymapOverrides };
export { ACTIONS };

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
type Mod = (typeof MOD_ORDER)[number];

// Effective bindings: defaults overlaid with user overrides. An override of
// null explicitly unbinds the action.
export function effective(overrides?: KeymapOverrides | null): Record<ActionId, Binding> {
  const map = {} as Record<ActionId, Binding>;
  for (const a of ACTIONS) {
    map[a.id] =
      overrides && Object.prototype.hasOwnProperty.call(overrides, a.id)
        ? overrides[a.id] ?? null
        : a.default;
  }
  return map;
}

// Canonical form used for matching: Mod resolved to the platform modifier,
// modifiers sorted, single letters uppercased. "Alt+Mod+Enter" on macOS
// becomes "Alt+Meta+Enter".
export function normalize(binding: Binding, isMac: boolean): string | null {
  if (!binding) return null;
  const parts = binding.split('+');
  let key = parts.pop() as string;
  if (key.length === 1) key = key.toUpperCase();
  const mods = new Set<Mod>(
    parts.map((m) => (m === 'Mod' ? (isMac ? 'Meta' : 'Ctrl') : (m as Mod)))
  );
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

const ACCEL_KEYS: Record<string, string> = {
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
export function toAccelerator(binding: Binding, platform: NodeJS.Platform): string | null {
  if (!binding) return null;
  const parts = binding.split('+');
  const key = parts.pop() as string;
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
export function describe(binding: Binding, isMac: boolean): string {
  if (!binding) return '';
  const SYM: Record<string, string> = isMac
    ? { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘', Mod: '⌘' }
    : { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Super', Mod: 'Ctrl' };
  const KEY: Record<string, string> = {
    Escape: 'Esc',
    Enter: isMac ? '⏎' : 'Enter',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Space: 'Space',
  };
  const parts = binding.split('+');
  const key = parts.pop() as string;
  const mods = parts.map((m) => SYM[m] || m);
  const shown = KEY[key] || key;
  return isMac ? mods.join('') + shown : [...mods, shown].join('+');
}
