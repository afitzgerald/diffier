'use strict';

/*
 * Pure keymap data — zero imports, zero Node-specific types. See
 * git-types.ts for why this split exists: main/keymap.ts's toAccelerator()
 * uses NodeJS.Platform, which would fail to resolve if the renderer program
 * (no Node lib) imported types from that file directly.
 */

export type ActionId =
  | 'next-diff'
  | 'prev-diff'
  | 'next-file'
  | 'prev-file'
  | 'focus-tree'
  | 'commit'
  | 'commit-execute'
  | 'commit-and-push'
  | 'commit-history'
  | 'push'
  | 'pull'
  | 'fetch'
  | 'branches'
  | 'stash'
  | 'rollback'
  | 'toggle-log'
  | 'filter'
  | 'annotate'
  | 'save'
  | 'open-repo'
  | 'refresh'
  | 'toggle-panel'
  | 'keymap-settings'
  | 'about-dialog';

export interface KeymapAction {
  id: ActionId;
  label: string;
  default: string | null;
}

// A binding as stored/recorded (may still contain the "Mod" pseudo-modifier),
// or null for explicitly unbound.
export type Binding = string | null;

// actionId -> binding | null, as persisted in settings.json / sent from the
// renderer's keymap dialog. Only overridden actions need to be present.
export type KeymapOverrides = Partial<Record<ActionId, Binding>>;

/*
 * Bindings are stored as strings like "F7", "Shift+F7", "Alt+Mod+Enter".
 * "Mod" is a platform pseudo-modifier: Cmd on macOS, Ctrl elsewhere. Defaults
 * use it so one keymap reads naturally on both platforms; user-recorded
 * bindings store the concrete modifiers that were pressed. A null binding
 * means the action is unbound.
 */
export const ACTIONS: KeymapAction[] = [
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
  { id: 'about-dialog', label: 'About Diffier', default: null },
];
