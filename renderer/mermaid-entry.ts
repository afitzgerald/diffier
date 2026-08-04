/*
 * Mermaid diagram bundle entry — built by esbuild into renderer/mermaid.js
 * (see package.json "build:mermaid", run on postinstall).
 *
 * Renders ```mermaid fenced code blocks in the markdown preview
 * (renderer/app/markdown.ts). securityLevel: 'strict' sanitizes any
 * HTML/click-handler content mermaid would otherwise inject into labels —
 * repo markdown is untrusted input. boot.ts doesn't call this; markdown.ts
 * calls window.DiffierMermaid.render() lazily, the first time it hits a
 * mermaid fence, so the (large) bundle only loads if a mermaid diagram
 * appears at all.
 *
 * Theming: mermaid bakes colors into the SVG at render time, so there's no
 * way to make an already-rendered diagram follow a CSS variable the way the
 * rest of the UI does. Instead, every render() call re-reads the app's
 * current theme vars (set on :root by theme.ts's applyTheme()) into
 * mermaid's `theme: 'base'` override, so a diagram always matches whatever
 * theme was active *at render time*. markdown.ts's refreshMermaidTheme()
 * covers the rest: it re-renders every diagram on screen when the theme
 * changes, so open diagrams don't stay stuck in the old palette.
 */

import mermaid from 'mermaid';

// Plain sRGB relative luminance (no gamma-correct coefficients needed here,
// just "is this background light or dark") to feed mermaid's darkMode flag.
function isDark(hexColor: string): boolean {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hexColor.trim());
  if (!m) return true;
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((h) => parseInt(h, 16));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 128;
}

function currentThemeVariables(): Record<string, string | boolean> {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue('--' + name).trim();
  const bg = v('bg') || '#1e1f22';
  return {
    darkMode: isDark(bg),
    background: bg,
    fontFamily: v('font-ui'),
    mainBkg: v('input-bg'),
    primaryColor: v('input-bg'),
    primaryTextColor: v('text-bright'),
    primaryBorderColor: v('border-light'),
    secondaryColor: v('hover'),
    tertiaryColor: v('panel-bg'),
    lineColor: v('dim'),
    textColor: v('text'),
    nodeTextColor: v('text-bright'),
    nodeBorder: v('border-light'),
    titleColor: v('text-bright'),
    edgeLabelBackground: bg,
    clusterBkg: v('panel-bg'),
    clusterBorder: v('border'),
  };
}

let counter = 0;

async function render(source: string): Promise<string> {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: currentThemeVariables(),
  });
  const { svg } = await mermaid.render(`diffier-mermaid-${counter++}`, source);
  return svg;
}

(window as unknown as { DiffierMermaid: { render: typeof render } }).DiffierMermaid = { render };
