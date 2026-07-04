'use strict';

const assert = require('assert');
const L = require('../renderer/languages');

// ---------------------------------------------------- Monarch grammar shape

const extraIds = L.EXTRA_LANGUAGES.map((l) => l.id);
assert.strictEqual(new Set(extraIds).size, extraIds.length, 'duplicate monarch ids');

for (const lang of L.EXTRA_LANGUAGES) {
  assert.ok(Array.isArray(lang.extensions) && lang.extensions.length, lang.id + ': extensions');
  for (const e of lang.extensions) assert.ok(e.startsWith('.'), `${lang.id}: bad extension ${e}`);
  assert.ok(Array.isArray(lang.tokenizer.root) && lang.tokenizer.root.length, lang.id + ': root state');
  for (const [stateName, rules] of Object.entries(lang.tokenizer)) {
    for (const rule of rules) {
      assert.ok(rule[0] instanceof RegExp, `${lang.id}.${stateName}: rule pattern must be RegExp`);
    }
  }
}

// -------------------------------------------------------- shiki metadata

const shikiIds = L.SHIKI_LANGUAGES.map((l) => l.id);
assert.strictEqual(new Set(shikiIds).size, shikiIds.length, 'duplicate shiki ids');
for (const id of extraIds) {
  assert.ok(shikiIds.includes(id), `monarch fallback ${id} missing from shiki set`);
}

// A file extension must resolve to exactly one of our languages.
const claimed = new Map();
for (const lang of L.SHIKI_LANGUAGES) {
  for (const e of lang.extensions || []) {
    assert.ok(!claimed.has(e), `extension ${e} claimed by ${lang.id} and ${claimed.get(e)}`);
    claimed.set(e, lang.id);
  }
}

// Every shiki grammar we reference must actually exist in @shikijs/langs.
const fs = require('fs');
const path = require('path');
const langsDist = path.join(__dirname, '..', 'node_modules', '@shikijs', 'langs', 'dist');
if (fs.existsSync(langsDist)) {
  for (const id of shikiIds) {
    assert.ok(
      fs.existsSync(path.join(langsDist, `${id}.mjs`)),
      `no @shikijs/langs grammar for ${id}`
    );
  }
} else {
  console.log('  (skipping grammar-existence check: @shikijs/langs not installed)');
}

// ------------------------------------------------------------- detection

const builtins = [
  { id: 'javascript', extensions: ['.js', '.jsx', '.mjs'] },
  { id: 'typescript', extensions: ['.ts', '.tsx'] },
  { id: 'python', extensions: ['.py'] },
  { id: 'html', extensions: ['.html'] },
  { id: 'ini', extensions: ['.ini'] },
  { id: 'json', extensions: ['.json'] },
  { id: 'yaml', extensions: ['.yaml', '.yml'] },
  { id: 'ruby', extensions: ['.rb'] },
  { id: 'shell', extensions: ['.sh', '.bash'] },
  { id: 'dockerfile', filenames: ['Dockerfile'] },
];

const withShiki = {
  languages: { getLanguages: () => [...builtins, ...L.SHIKI_LANGUAGES] },
};
const withoutShiki = {
  languages: { getLanguages: () => [...builtins, ...L.EXTRA_LANGUAGES] },
};

const cases = [
  // [path, content, expected with shiki, expected without shiki]
  ['Makefile', '', 'make', 'make'],
  ['src/deps.zig', '', 'zig', 'zig'],
  ['Cargo.toml', '', 'toml', 'toml'],
  ['Cargo.lock', '', 'toml', 'toml'],
  ['app/App.vue', '', 'vue', 'html'],           // real grammar vs. html fallback
  ['ui/Widget.svelte', '', 'svelte', 'html'],
  ['schema.prisma', '', 'prisma', 'plaintext'],
  ['shaders/main.frag', '', 'glsl', 'plaintext'],
  ['Jenkinsfile', '', 'groovy', 'groovy'],
  ['deploy/dockerfile', '', 'dockerfile', 'dockerfile'], // case-insensitive
  ['Gemfile', '', 'ruby', 'ruby'],
  ['.gitignore', '', 'ini', 'ini'],
  ['.env.production', '', 'ini', 'ini'],
  ['fix.patch', '', 'diff', 'diff'],
  ['flake.nix', '', 'nix', 'nix'],
  ['src/Main.hs', '', 'haskell', 'haskell'],
  ['bin/run', '#!/usr/bin/env python3\nprint(1)', 'python', 'python'],
  ['bin/cli', '#!/usr/bin/env node\nx', 'javascript', 'javascript'],
  ['bin/setup', '#!/bin/bash\nx', 'shell', 'shell'],
  ['notes.mystery', 'hello', 'plaintext', 'plaintext'],
  ['src/app.tsx', '', 'typescript', 'typescript'],
];

for (const [p, content, expShiki, expFallback] of cases) {
  assert.strictEqual(L.detect(withShiki, p, content), expShiki, `shiki: ${p}`);
  assert.strictEqual(L.detect(withoutShiki, p, content), expFallback, `fallback: ${p}`);
}

console.log('languages.test.js OK');
