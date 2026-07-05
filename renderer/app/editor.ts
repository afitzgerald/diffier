'use strict';

/* Monaco bootstrap, diff editor creation, language detection.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

// ------------------------------------------------------------------ monaco

const monacoReady: Promise<void> = new Promise((resolve) => {
  require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
  // Workers can't be created cross-origin from file:// — monaco falls back to
  // computing diffs on the main thread, which is fine at our file sizes.
  window.MonacoEnvironment = {
    getWorker: (): never => {
      throw new Error('workers disabled; monaco falls back to main thread');
    },
  };
  require(['vs/editor/editor.main'], async () => {
    // Monaco binds F7/Shift+F7 to its accessible diff viewer; difference
    // navigation is ours (and rebindable), so drop Monaco's claim on them.
    try {
      monaco.editor.addKeybindingRules([
        { keybinding: monaco.KeyCode.F7, command: null },
        { keybinding: monaco.KeyMod.Shift | monaco.KeyCode.F7, command: null },
      ]);
    } catch {
      /* older monaco without addKeybindingRules */
    }
    window.DiffierLanguages.register(monaco);
    if (window.DiffierShiki) {
      try {
        await window.DiffierShiki.init(monaco, Object.values(THEMES).map(toShikiTheme));
        shikiActive = true;
        window.__shikiActive = true; // surfaced for tests and support diagnostics
      } catch (err) {
        console.warn('Shiki highlighter unavailable, using built-in grammars:', err);
      }
    }
    monaco.editor.defineTheme('diffier-theme', currentTheme().monaco);

    diffEditor = monaco.editor.createDiffEditor($('diff-editor'), {
      theme: 'diffier-theme',
      automaticLayout: true,
      renderSideBySide: state.settings.viewMode !== 'unified',
      originalEditable: false,
      readOnly: true,
      ignoreTrimWhitespace: !!state.settings.ignoreWhitespace,
      renderMarginRevertIcon: true,
      fontFamily: 'SF Mono, Menlo, Monaco, JetBrains Mono, Consolas, monospace',
      ...zoomedEditorFontOptions(),
      scrollBeyondLastLine: false,
      renderOverviewRuler: true,
      diffWordWrap: 'off',
      minimap: { enabled: false },
      padding: { top: 4 },
      // The advanced algorithm gives cleaner hunk boundaries and powers move
      // detection (a block cut from one place and pasted elsewhere is shown
      // as a move, not a delete+add pair).
      diffAlgorithm: 'advanced',
      experimental: { showMoves: true },
      // Diffs can contain untrusted content (a fetched branch, a patch from
      // someone else) — surface invisible/confusable Unicode (Trojan Source
      // style attacks) instead of rendering it silently.
      unicodeHighlight: { invisibleCharacters: true, ambiguousCharacters: true },
    });

    diffEditor.onDidUpdateDiff(() => {
      updateDiffCount();
      updateHunkDecorations();
    });

    // Hunk include/exclude checkboxes live in the glyph margin of the
    // modified editor (IntelliJ's partial-commit gutter).
    diffEditor.getModifiedEditor().updateOptions({ glyphMargin: true });
    diffEditor.getModifiedEditor().onMouseDown((e) => {
      if (
        !e.target ||
        e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        !e.target.element ||
        !e.target.element.classList.contains('hunk-check')
      ) {
        return;
      }
      const line = e.target.position!.lineNumber;
      const c = getLineChanges().find((ch) => changeStartLine(ch) === line);
      if (c) toggleHunk(c);
    });

    // Any keypress other than the next/prev-difference bindings (or a bare
    // modifier, e.g. the Shift in Shift+F7) disarms the "go to next file"
    // prompt.
    diffEditor.getModifiedEditor().onKeyDown((e) => {
      const b = eventToBinding(e.browserEvent);
      if (!b) return; // bare modifier
      if (b !== km.bindings.get('next-diff') && b !== km.bindings.get('prev-diff')) {
        state.f7Armed = false;
        state.shiftF7Armed = false;
      }
    });

    // Blame annotations go stale as soon as the buffer is edited.
    resolve();
  });
});

function getLineChanges(): monaco.editor.ILineChange[] {
  return (diffEditor && diffEditor.getLineChanges()) || [];
}

function updateDiffCount(): void {
  const el = $('diff-count');
  if (!state.current && !state.readOnlyDiff) {
    el.textContent = '';
    return;
  }
  const n = getLineChanges().length;
  el.textContent = n === 0 ? 'Contents are identical' : `${n} difference${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------- language

function languageFor(filePath: string, content?: string | null): string {
  return window.DiffierLanguages.detect(monaco, filePath, content);
}
