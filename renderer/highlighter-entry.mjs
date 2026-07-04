/*
 * Shiki highlighter bundle entry — built by esbuild into
 * renderer/highlighter.js (see package.json "build:highlighter", run on
 * postinstall).
 *
 * Provides TextMate-grammar syntax highlighting (the grammars VS Code uses)
 * for the languages Monaco's bundled Monarch set lacks, tokenized with
 * shiki's pure-JavaScript regex engine (no WASM, so the strict renderer CSP
 * stays untouched) and wired into Monaco via @shikijs/monaco.
 *
 * The language list and file metadata live in languages.js
 * (SHIKI_LANGUAGES) so detection, registration, and tests share one source.
 * app.js calls window.DiffierShiki.init() after Monaco loads; if this bundle
 * is missing the app falls back to the hand-written Monarch grammars.
 */

import { createHighlighterCore } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import { shikiToMonaco } from '@shikijs/monaco';
import meta from './languages.js';

import vue from '@shikijs/langs/vue';
import svelte from '@shikijs/langs/svelte';
import astro from '@shikijs/langs/astro';
import toml from '@shikijs/langs/toml';
import make from '@shikijs/langs/make';
import cmake from '@shikijs/langs/cmake';
import groovy from '@shikijs/langs/groovy';
import haskell from '@shikijs/langs/haskell';
import erlang from '@shikijs/langs/erlang';
import zig from '@shikijs/langs/zig';
import nix from '@shikijs/langs/nix';
import latex from '@shikijs/langs/latex';
import diff from '@shikijs/langs/diff';
import elm from '@shikijs/langs/elm';
import ocaml from '@shikijs/langs/ocaml';
import crystal from '@shikijs/langs/crystal';
import nim from '@shikijs/langs/nim';
import prisma from '@shikijs/langs/prisma';
import glsl from '@shikijs/langs/glsl';
import dlang from '@shikijs/langs/d';
import gleam from '@shikijs/langs/gleam';
import odin from '@shikijs/langs/odin';
import purescript from '@shikijs/langs/purescript';
import ada from '@shikijs/langs/ada';
import asm from '@shikijs/langs/asm';
import awk from '@shikijs/langs/awk';
import haxe from '@shikijs/langs/haxe';
import commonLisp from '@shikijs/langs/common-lisp';
import racket from '@shikijs/langs/racket';

const GRAMMARS = [
  vue, svelte, astro, toml, make, cmake, groovy, haskell, erlang, zig, nix,
  latex, diff, elm, ocaml, crystal, nim, prisma, glsl, dlang, gleam, odin,
  purescript, ada, asm, awk, haxe, commonLisp, racket,
];

/**
 * @param monaco the loaded monaco namespace
 * @param themes TextMate theme objects (one per Diffier theme, named
 *               "diffier-<themeId>"); monaco.editor.setTheme() with those
 *               names switches token colors after init.
 */
async function init(monaco, themes) {
  const highlighter = await createHighlighterCore({
    themes,
    langs: GRAMMARS.flat(),
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });

  // Register the ids with their file metadata so language detection via
  // monaco.languages.getLanguages() picks them up, then let shiki take over
  // tokenization for them.
  for (const lang of meta.SHIKI_LANGUAGES) {
    monaco.languages.register({
      id: lang.id,
      extensions: lang.extensions || [],
      filenames: lang.filenames || [],
    });
  }
  shikiToMonaco(highlighter, monaco);
  return highlighter.getLoadedLanguages();
}

window.DiffierShiki = { init };
