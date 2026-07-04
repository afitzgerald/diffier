'use strict';
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const km = __importStar(require("../main/keymap"));
// effective(): defaults, overrides, explicit unbind
const eff = km.effective({ 'next-diff': 'Ctrl+J', 'push': null });
assert_1.default.strictEqual(eff['next-diff'], 'Ctrl+J');
assert_1.default.strictEqual(eff['push'], null);
assert_1.default.strictEqual(eff['prev-diff'], 'Shift+F7');
assert_1.default.strictEqual(km.effective({})['next-diff'], 'F7');
// normalize(): Mod resolution, modifier ordering, letter case
assert_1.default.strictEqual(km.normalize('Mod+K', true), 'Meta+K');
assert_1.default.strictEqual(km.normalize('Mod+K', false), 'Ctrl+K');
assert_1.default.strictEqual(km.normalize('Shift+Alt+x', false), 'Alt+Shift+X');
assert_1.default.strictEqual(km.normalize('Alt+Mod+Enter', true), 'Alt+Meta+Enter');
assert_1.default.strictEqual(km.normalize(null, true), null);
// toAccelerator(): valid conversions
assert_1.default.strictEqual(km.toAccelerator('F7', 'darwin'), 'F7');
assert_1.default.strictEqual(km.toAccelerator('Shift+F7', 'darwin'), 'Shift+F7');
assert_1.default.strictEqual(km.toAccelerator('Mod+Shift+]', 'darwin'), 'CommandOrControl+Shift+]');
assert_1.default.strictEqual(km.toAccelerator('Alt+Mod+Enter', 'darwin'), 'Alt+CommandOrControl+Return');
assert_1.default.strictEqual(km.toAccelerator('Meta+K', 'darwin'), 'Cmd+K');
assert_1.default.strictEqual(km.toAccelerator('Meta+K', 'linux'), 'Super+K');
assert_1.default.strictEqual(km.toAccelerator('Ctrl+ArrowRight', 'linux'), 'Ctrl+Right');
assert_1.default.strictEqual(km.toAccelerator('Mod+,', 'darwin'), 'CommandOrControl+,');
// toAccelerator(): renderer-only bindings must NOT become menu accelerators
assert_1.default.strictEqual(km.toAccelerator('Escape', 'darwin'), null, 'Escape would eat every Esc');
assert_1.default.strictEqual(km.toAccelerator('K', 'darwin'), null, 'bare key would fire while typing');
assert_1.default.strictEqual(km.toAccelerator('Shift+K', 'darwin'), null, 'shift+key is still typing');
assert_1.default.strictEqual(km.toAccelerator(null, 'darwin'), null);
assert_1.default.strictEqual(km.toAccelerator('F7', 'linux'), 'F7', 'bare F-keys are fine');
// describe(): human-readable hints
assert_1.default.strictEqual(km.describe('Escape', true), 'Esc');
assert_1.default.strictEqual(km.describe('Mod+K', true), '⌘K');
assert_1.default.strictEqual(km.describe('Mod+K', false), 'Ctrl+K');
assert_1.default.strictEqual(km.describe('Alt+Mod+Enter', true), '⌥⌘⏎');
// Every default binding is unique after normalization (no silent conflicts).
for (const isMac of [true, false]) {
    const seen = new Map();
    for (const a of km.ACTIONS) {
        const n = km.normalize(a.default, isMac);
        if (n === null)
            continue; // unbound by default
        assert_1.default.ok(!seen.has(n), `default conflict: ${a.id} vs ${seen.get(n)} on ${n}`);
        seen.set(n, a.id);
    }
}
console.log('keymap.test.js OK');
