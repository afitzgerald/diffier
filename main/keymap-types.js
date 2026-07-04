'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACTIONS = void 0;
/*
 * Bindings are stored as strings like "F7", "Shift+F7", "Alt+Mod+Enter".
 * "Mod" is a platform pseudo-modifier: Cmd on macOS, Ctrl elsewhere. Defaults
 * use it so one keymap reads naturally on both platforms; user-recorded
 * bindings store the concrete modifiers that were pressed. A null binding
 * means the action is unbound.
 */
exports.ACTIONS = [
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
