'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACTIONS = void 0;
exports.effective = effective;
exports.normalize = normalize;
exports.toAccelerator = toAccelerator;
exports.describe = describe;
const keymap_types_1 = require("./keymap-types");
Object.defineProperty(exports, "ACTIONS", { enumerable: true, get: function () { return keymap_types_1.ACTIONS; } });
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];
// Effective bindings: defaults overlaid with user overrides. An override of
// null explicitly unbinds the action.
function effective(overrides) {
    const map = {};
    for (const a of keymap_types_1.ACTIONS) {
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
function normalize(binding, isMac) {
    if (!binding)
        return null;
    const parts = binding.split('+');
    let key = parts.pop();
    if (key.length === 1)
        key = key.toUpperCase();
    const mods = new Set(parts.map((m) => (m === 'Mod' ? (isMac ? 'Meta' : 'Ctrl') : m)));
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
    if (!binding)
        return null;
    const parts = binding.split('+');
    const key = parts.pop();
    if (key === 'Escape')
        return null;
    const hasRealMod = parts.some((m) => m !== 'Shift');
    if (!hasRealMod && !/^F\d+$/.test(key))
        return null;
    const mods = parts.map((m) => {
        if (m === 'Mod')
            return 'CommandOrControl';
        if (m === 'Meta')
            return platform === 'darwin' ? 'Cmd' : 'Super';
        return m; // Ctrl, Alt, Shift
    });
    const accelKey = ACCEL_KEYS[key] || (key.length === 1 ? key.toUpperCase() : key);
    return [...mods, accelKey].join('+');
}
// Human-readable form for menu label hints on accelerator-less bindings.
function describe(binding, isMac) {
    if (!binding)
        return '';
    const SYM = isMac
        ? { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘', Mod: '⌘' }
        : { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Super', Mod: 'Ctrl' };
    const KEY = {
        Escape: 'Esc',
        Enter: isMac ? '⏎' : 'Enter',
        ArrowUp: '↑',
        ArrowDown: '↓',
        ArrowLeft: '←',
        ArrowRight: '→',
        Space: 'Space',
    };
    const parts = binding.split('+');
    const key = parts.pop();
    const mods = parts.map((m) => SYM[m] || m);
    const shown = KEY[key] || key;
    return isMac ? mods.join('') + shown : [...mods, shown].join('+');
}
