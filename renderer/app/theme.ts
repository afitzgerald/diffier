'use strict';

/* Theme application and shiki theme mapping.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html. */

// ------------------------------------------------------------------ themes

const THEMES: Record<ThemeId, Theme> = window.api.themes || ({} as Record<ThemeId, Theme>);
const DEFAULT_THEME: ThemeId = window.api.defaultTheme || 'islands-dark';

function currentTheme(): Theme {
  const id = state.settings.theme;
  return (id && THEMES[id]) || THEMES[DEFAULT_THEME]!;
}

let shikiActive = false;

// The shiki TextMate theme JSON shape shikiToMonaco()/createHighlighterCore()
// expect — distinct from Monaco's own IStandaloneThemeData (different field
// names: `type` not `base`, `settings[].scope`/`settings[].settings` instead
// of `rules[].token`).
interface ShikiThemeInput {
  name: string;
  type: 'light' | 'dark';
  colors: Record<string, string>;
  settings: { scope?: string | string[]; settings: { foreground?: string; background?: string } }[];
}

// Convert a Diffier theme into a TextMate theme for shiki: the monaco
// `colors` are already VS Code color keys, and the Monarch token rules map
// onto the equivalent TextMate scopes.
function toShikiTheme(t: Theme): ShikiThemeInput {
  const ruleColor = (token: string): string | undefined => {
    const r = t.monaco.rules.find((x) => x.token === token);
    return r && r.foreground ? '#' + r.foreground : undefined;
  };
  const fg = ruleColor('') || t.monaco.colors['editor.foreground'];
  const scopeMap: [string[], string | undefined][] = [
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
    colors: { ...t.monaco.colors, 'editor.foreground': fg! },
    settings: [
      { settings: { foreground: fg, background: t.monaco.colors['editor.background'] } },
      ...scopeMap
        .filter((entry): entry is [string[], string] => !!entry[1])
        .map(([scope, color]) => ({ scope, settings: { foreground: color } })),
    ],
  };
}

function applyTheme(id: ThemeId): void {
  const t = THEMES[id] || THEMES[DEFAULT_THEME];
  if (!t) return;
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
    } else {
      monaco.editor.defineTheme('diffier-theme', t.monaco);
      monaco.editor.setTheme('diffier-theme');
    }
  }
  const sel = $<HTMLSelectElement>('theme-select');
  if (sel && sel.value !== t.id) sel.value = t.id;
  // mermaid bakes colors into its SVG at render time from these same CSS
  // vars (see mermaid-entry.ts) — re-render any diagram on screen so it
  // doesn't stay stuck in the old theme's colors.
  refreshMermaidTheme();
}

async function setTheme(id: ThemeId): Promise<void> {
  applyTheme(id);
  try {
    await window.api.setSettings({ theme: state.settings.theme });
  } catch (err) {
    toast('Failed to save theme: ' + errMsg(err), true);
  }
}
