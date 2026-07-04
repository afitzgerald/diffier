'use strict';

const assert = require('assert');
const { THEMES, DEFAULT_THEME } = require('../main/themes');

assert.ok(THEMES[DEFAULT_THEME], 'default theme must exist');
assert.strictEqual(DEFAULT_THEME, 'islands-dark', 'Islands Dark is the default');
assert.ok(Object.keys(THEMES).length >= 2, 'must offer alternatives');

const referenceVars = Object.keys(THEMES[DEFAULT_THEME].vars).sort();
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;

for (const [id, t] of Object.entries(THEMES)) {
  assert.strictEqual(t.id, id, `${id}: id field must match key`);
  assert.ok(t.label, `${id}: label required`);
  assert.ok(['islands', 'classic'].includes(t.style), `${id}: bad style "${t.style}"`);

  // Every theme must define exactly the same CSS variables, so switching
  // themes can never leave a stale color from the previous theme behind.
  assert.deepStrictEqual(
    Object.keys(t.vars).sort(),
    referenceVars,
    `${id}: vars must match the default theme's variable set`
  );
  for (const [k, v] of Object.entries(t.vars)) {
    assert.ok(HEX.test(v), `${id}: var ${k} is not a hex color: ${v}`);
  }

  // Monaco theme sanity: valid base and required diff colors present.
  assert.ok(['vs', 'vs-dark', 'hc-black', 'hc-light'].includes(t.monaco.base), `${id}: bad monaco base`);
  assert.ok(Array.isArray(t.monaco.rules) && t.monaco.rules.length, `${id}: monaco rules`);
  for (const key of [
    'editor.background',
    'diffEditor.insertedLineBackground',
    'diffEditor.removedLineBackground',
  ]) {
    assert.ok(t.monaco.colors[key], `${id}: missing monaco color ${key}`);
  }

  // A dark window must not get a light editor and vice versa.
  const darkEditor = t.monaco.base !== 'vs' && t.monaco.base !== 'hc-light';
  const bgLum = parseInt(t.vars.bg.slice(1, 3), 16);
  assert.strictEqual(bgLum < 0x80, darkEditor, `${id}: editor/base brightness mismatch`);
}

console.log('themes.test.js OK');
