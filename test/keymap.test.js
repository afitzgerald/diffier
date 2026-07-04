'use strict';

const assert = require('assert');
const km = require('../main/keymap');

// effective(): defaults, overrides, explicit unbind
const eff = km.effective({ 'next-diff': 'Ctrl+J', 'push': null });
assert.strictEqual(eff['next-diff'], 'Ctrl+J');
assert.strictEqual(eff['push'], null);
assert.strictEqual(eff['prev-diff'], 'Shift+F7');
assert.strictEqual(km.effective({})['next-diff'], 'F7');

// normalize(): Mod resolution, modifier ordering, letter case
assert.strictEqual(km.normalize('Mod+K', true), 'Meta+K');
assert.strictEqual(km.normalize('Mod+K', false), 'Ctrl+K');
assert.strictEqual(km.normalize('Shift+Alt+x', false), 'Alt+Shift+X');
assert.strictEqual(km.normalize('Alt+Mod+Enter', true), 'Alt+Meta+Enter');
assert.strictEqual(km.normalize(null, true), null);

// toAccelerator(): valid conversions
assert.strictEqual(km.toAccelerator('F7', 'darwin'), 'F7');
assert.strictEqual(km.toAccelerator('Shift+F7', 'darwin'), 'Shift+F7');
assert.strictEqual(km.toAccelerator('Mod+Shift+]', 'darwin'), 'CommandOrControl+Shift+]');
assert.strictEqual(km.toAccelerator('Alt+Mod+Enter', 'darwin'), 'Alt+CommandOrControl+Return');
assert.strictEqual(km.toAccelerator('Meta+K', 'darwin'), 'Cmd+K');
assert.strictEqual(km.toAccelerator('Meta+K', 'linux'), 'Super+K');
assert.strictEqual(km.toAccelerator('Ctrl+ArrowRight', 'linux'), 'Ctrl+Right');
assert.strictEqual(km.toAccelerator('Mod+,', 'darwin'), 'CommandOrControl+,');

// toAccelerator(): renderer-only bindings must NOT become menu accelerators
assert.strictEqual(km.toAccelerator('Escape', 'darwin'), null, 'Escape would eat every Esc');
assert.strictEqual(km.toAccelerator('K', 'darwin'), null, 'bare key would fire while typing');
assert.strictEqual(km.toAccelerator('Shift+K', 'darwin'), null, 'shift+key is still typing');
assert.strictEqual(km.toAccelerator(null, 'darwin'), null);
assert.strictEqual(km.toAccelerator('F7', 'linux'), 'F7', 'bare F-keys are fine');

// describe(): human-readable hints
assert.strictEqual(km.describe('Escape', true), 'Esc');
assert.strictEqual(km.describe('Mod+K', true), '⌘K');
assert.strictEqual(km.describe('Mod+K', false), 'Ctrl+K');
assert.strictEqual(km.describe('Alt+Mod+Enter', true), '⌥⌘⏎');

// Every default binding is unique after normalization (no silent conflicts).
for (const isMac of [true, false]) {
  const seen = new Map();
  for (const a of km.ACTIONS) {
    const n = km.normalize(a.default, isMac);
    assert.ok(!seen.has(n), `default conflict: ${a.id} vs ${seen.get(n)} on ${n}`);
    seen.set(n, a.id);
  }
}

console.log('keymap.test.js OK');
