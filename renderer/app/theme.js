'use strict';
/* Theme application and shiki theme mapping.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */
// ------------------------------------------------------------------ themes
const THEMES = window.api.themes || {};
const DEFAULT_THEME = window.api.defaultTheme || 'islands-dark';
function currentTheme() {
    const id = state.settings.theme;
    return (id && THEMES[id]) || THEMES[DEFAULT_THEME];
}
let shikiActive = false;
// Convert a Diffier theme into a TextMate theme for shiki: the monaco
// `colors` are already VS Code color keys, and the Monarch token rules map
// onto the equivalent TextMate scopes.
function toShikiTheme(t) {
    const ruleColor = (token) => {
        const r = t.monaco.rules.find((x) => x.token === token);
        return r && r.foreground ? '#' + r.foreground : undefined;
    };
    const fg = ruleColor('') || t.monaco.colors['editor.foreground'];
    const scopeMap = [
        [['comment', 'punctuation.definition.comment'], ruleColor('comment')],
        [['string', 'punctuation.definition.string', 'markup.inserted'], ruleColor('string')],
        [
            ['constant.numeric', 'constant.language', 'constant.character', 'constant.other'],
            ruleColor('number'),
        ],
        [
            ['keyword', 'keyword.operator.new', 'storage', 'storage.type', 'storage.modifier'],
            ruleColor('keyword'),
        ],
        [
            [
                'entity.name.type',
                'entity.name.class',
                'entity.name.function',
                'entity.name.namespace',
                'support.function',
                'support.class',
                'support.type',
            ],
            ruleColor('type'),
        ],
        [
            ['entity.name.tag', 'punctuation.definition.tag', 'entity.other.attribute-name'],
            ruleColor('tag'),
        ],
        [['markup.deleted', 'invalid'], t.vars['st-conflict']],
    ];
    return {
        name: 'diffier-' + t.id,
        type: t.monaco.base === 'vs' || t.monaco.base === 'hc-light' ? 'light' : 'dark',
        colors: { ...t.monaco.colors, 'editor.foreground': fg },
        settings: [
            { settings: { foreground: fg, background: t.monaco.colors['editor.background'] } },
            ...scopeMap
                .filter((entry) => !!entry[1])
                .map(([scope, color]) => ({ scope, settings: { foreground: color } })),
        ],
    };
}
function applyTheme(id) {
    const t = THEMES[id] || THEMES[DEFAULT_THEME];
    if (!t)
        return;
    for (const [k, v] of Object.entries(t.vars)) {
        document.documentElement.style.setProperty('--' + k, v);
    }
    document.body.dataset.theme = t.id;
    document.body.dataset.themeStyle = t.style;
    state.settings.theme = t.id;
    if (window.monaco && monaco.editor) {
        if (shikiActive) {
            // shikiToMonaco registered one monaco theme per Diffier theme (with
            // TextMate token colors); its patched setTheme switches both.
            monaco.editor.setTheme('diffier-' + t.id);
        }
        else {
            monaco.editor.defineTheme('diffier-theme', t.monaco);
            monaco.editor.setTheme('diffier-theme');
        }
    }
    const sel = $('theme-select');
    if (sel && sel.value !== t.id)
        sel.value = t.id;
}
async function setTheme(id) {
    applyTheme(id);
    try {
        await window.api.setSettings({ theme: state.settings.theme });
    }
    catch {
        /* theme still applied locally */
    }
}
