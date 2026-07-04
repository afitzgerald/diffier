'use strict';
/* Inline git blame annotations.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */
// ------------------------------------------------------------------- blame
let blameDecorationIds = [];
function clearBlame() {
    if (!blameDecorationIds.length || !diffEditor)
        return;
    blameDecorationIds = diffEditor.getModifiedEditor().deltaDecorations(blameDecorationIds, []);
}
async function applyBlame() {
    if (!state.current ||
        state.readOnlyDiff ||
        state.conflict ||
        !modifiedModel ||
        state.current.type === 'DELETED' ||
        state.current.type === 'UNVERSIONED') {
        clearBlame();
        return;
    }
    await autosaveIfDirty();
    const file = state.current;
    let lines;
    try {
        lines = await window.api.gitBlame(file.path);
    }
    catch (err) {
        toast('Blame failed: ' + errMsg(err), true);
        return;
    }
    if (!state.blameOn || state.current !== file || !modifiedModel)
        return;
    const decos = [];
    const max = Math.min(lines.length, modifiedModel.getLineCount());
    for (let i = 0; i < max; i++) {
        const b = lines[i];
        const col = modifiedModel.getLineMaxColumn(i + 1);
        const date = b.time ? new Date(b.time).toISOString().slice(0, 10) : '';
        const text = b.uncommitted
            ? '    · not committed'
            : `    · ${b.author} ${date} ${b.sha}`;
        decos.push({
            range: new monaco.Range(i + 1, col, i + 1, col),
            // showIfCollapsed: injected text on an empty (collapsed) range is
            // filtered out of rendering without it.
            options: { showIfCollapsed: true, after: { content: text, inlineClassName: 'blame-inline' } },
        });
    }
    blameDecorationIds = diffEditor.getModifiedEditor().deltaDecorations(blameDecorationIds, decos);
}
function toggleBlame() {
    state.blameOn = !state.blameOn;
    $('btn-blame').classList.toggle('active', state.blameOn);
    if (state.blameOn)
        applyBlame();
    else
        clearBlame();
}
