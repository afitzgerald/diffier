'use strict';

/* Markdown rendering for the diff pane's markdown preview.
   Part of the Diffier renderer — classic scripts share module scope;
   load order is defined in index.html.

   Hand-written GFM subset (headings, lists, task lists, fenced code,
   blockquotes, tables, emphasis, links, images) that builds DOM nodes
   directly — never innerHTML — so untrusted repo content cannot inject
   markup: raw HTML in the source renders as literal text. Links get no
   real navigation here; boot.ts routes clicks to shell.openExternal. */

// Where the markdown file lives, for resolving relative image paths:
// `root` is the repo root (absolute), `dir` the file's directory inside it.
interface MarkdownBase {
  root: string;
  dir: string;
}

const markdownRenderer = (() => {
  // --------------------------------------------------------------- helpers

  const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*(\S*)/;
  const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
  const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
  const QUOTE = /^ {0,3}> ?/;
  const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])( +)(.*)$/;
  const TABLE_SEP = /^ {0,3}\|?(\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/;

  function leadingSpaces(line: string): number {
    return line.length - line.trimStart().length;
  }

  // Resolve a relative image path against the file's directory, refusing to
  // escape the repo root (same spirit as main/git.ts's insideRepo).
  function resolveRepoPath(base: MarkdownBase, rel: string): string | null {
    const parts = (base.dir + '/' + rel).split('/');
    const out: string[] = [];
    for (const p of parts) {
      if (!p || p === '.') continue;
      if (p === '..') {
        if (!out.length) return null;
        out.pop();
        continue;
      }
      out.push(p);
    }
    return base.root + '/' + out.join('/');
  }

  function fileUrl(absPath: string): string {
    return 'file://' + absPath.split('/').map(encodeURIComponent).join('/');
  }

  // ---------------------------------------------------------------- inline

  const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~<>|"']/;

  function makeLink(href: string, title: string | null): HTMLAnchorElement {
    const a = document.createElement('a');
    // No real href: navigation is blocked in main and boot.ts's delegate
    // opens http(s) targets externally from data-href instead.
    a.dataset.href = href;
    a.title = title ? `${title} — ${href}` : href;
    // No href means the browser won't put this in the tab order or expose
    // it as a link by default — restore both explicitly.
    a.tabIndex = 0;
    a.setAttribute('role', 'link');
    return a;
  }

  function makeImage(src: string, alt: string, title: string | null, base: MarkdownBase | null): Node {
    const fallback = () => {
      const span = document.createElement('span');
      span.className = 'md-img-fallback';
      span.textContent = alt || src;
      return span;
    };
    let url: string | null = null;
    if (/^data:image\//i.test(src) || /^https?:\/\//i.test(src)) {
      url = src; // http(s) is blocked by the CSP; the error handler kicks in
    } else if (base && !/^[a-z][a-z0-9+.-]*:/i.test(src)) {
      // A leading "/" means repo-root-relative (like a real site root), not
      // relative to the markdown file's own directory.
      const abs = src.startsWith('/')
        ? resolveRepoPath({ root: base.root, dir: '' }, src.slice(1))
        : resolveRepoPath(base, src);
      if (abs) url = fileUrl(abs);
    }
    if (!url) return fallback();
    const img = document.createElement('img');
    img.alt = alt;
    if (title) img.title = title;
    img.addEventListener('error', () => img.replaceWith(fallback()));
    img.src = url;
    return img;
  }

  // Append `src` to `out` with inline markdown (code, emphasis, links, …)
  // converted to elements and everything else as literal text.
  function inline(src: string, out: Node, base: MarkdownBase | null): void {
    let i = 0;
    let plain = '';
    const flush = () => {
      if (plain) {
        out.appendChild(document.createTextNode(plain));
        plain = '';
      }
    };
    const LINK_RE = /^\[([^\]]*)\]\(\s*(?:<([^>]*)>|([^\s)]*))(?:\s+("[^"]*"|'[^']*'))?\s*\)/;

    while (i < src.length) {
      const ch = src[i]!;
      const rest = src.slice(i);
      let m: RegExpExecArray | null;

      if (ch === '\\' && i + 1 < src.length && ESCAPABLE.test(src[i + 1]!) && src[i + 1] !== '\n') {
        plain += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === '\n') {
        // Hard break on two trailing spaces or a trailing backslash.
        if (/( {2,}|\\)$/.test(plain)) {
          plain = plain.replace(/( +|\\)$/, '');
          flush();
          out.appendChild(document.createElement('br'));
        } else {
          plain += '\n';
        }
        i++;
        continue;
      }
      if (ch === '`' && (m = /^(`+)([\s\S]*?)\1(?!`)/.exec(rest))) {
        flush();
        const code = document.createElement('code');
        // GFM strips one surrounding space pair: ` `code` ` → `code`.
        code.textContent = m[2]!.replace(/^ ([\s\S]*) $/, '$1');
        out.appendChild(code);
        i += m[0].length;
        continue;
      }
      if (ch === '!' && (m = LINK_RE.exec(rest.slice(1)))) {
        flush();
        const title = m[4] ? m[4].slice(1, -1) : null;
        out.appendChild(makeImage(m[2] ?? m[3] ?? '', m[1]!, title, base));
        i += 1 + m[0].length;
        continue;
      }
      if (ch === '[' && (m = LINK_RE.exec(rest))) {
        flush();
        const a = makeLink(m[2] ?? m[3] ?? '', m[4] ? m[4].slice(1, -1) : null);
        inline(m[1]!, a, base);
        out.appendChild(a);
        i += m[0].length;
        continue;
      }
      if (ch === '<' && (m = /^<(https?:\/\/[^\s<>]+)>/.exec(rest))) {
        flush();
        const a = makeLink(m[1]!, null);
        a.textContent = m[1]!;
        out.appendChild(a);
        i += m[0].length;
        continue;
      }
      // GFM-style bare URL autolink at a word boundary.
      if (
        ch === 'h' &&
        (plain === '' || /[\s(]$/.test(plain)) &&
        (m = /^https?:\/\/[^\s<>]+[^\s<>.,:;!?)]/.exec(rest))
      ) {
        flush();
        const a = makeLink(m[0], null);
        a.textContent = m[0];
        out.appendChild(a);
        i += m[0].length;
        continue;
      }
      if ((ch === '*' || ch === '_') && (m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest))) {
        if (ch !== '_' || !/[A-Za-z0-9]$/.test(plain)) {
          flush();
          const strong = document.createElement('strong');
          inline(m[2]!, strong, base);
          out.appendChild(strong);
          i += m[0].length;
          continue;
        }
      }
      if ((ch === '*' || ch === '_') && (m = /^([*_])(?=[^\s*_])([\s\S]*?[^\s*_])\1/.exec(rest))) {
        // `_` inside a word (snake_case) is literal, not emphasis.
        if (ch !== '_' || !/[A-Za-z0-9]$/.test(plain)) {
          flush();
          const em = document.createElement('em');
          inline(m[2]!, em, base);
          out.appendChild(em);
          i += m[0].length;
          continue;
        }
      }
      if (ch === '~' && (m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) {
        flush();
        const del = document.createElement('del');
        inline(m[1]!, del, base);
        out.appendChild(del);
        i += m[0].length;
        continue;
      }
      plain += ch;
      i++;
    }
    flush();
  }

  // ---------------------------------------------------------------- blocks

  function isBlockStart(line: string): boolean {
    return (
      FENCE_OPEN.test(line) ||
      HEADING.test(line) ||
      HR.test(line) ||
      QUOTE.test(line) ||
      LIST_ITEM.test(line)
    );
  }

  function splitTableRow(line: string): string[] {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    const cells: string[] = [];
    let cur = '';
    for (let k = 0; k < s.length; k++) {
      const c = s[k]!;
      if (c === '\\' && s[k + 1] === '|') {
        cur += '|';
        k++;
      } else if (c === '|') {
        cells.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    cells.push(cur.trim());
    return cells;
  }

  function parseTable(lines: string[], i: number, out: HTMLElement, base: MarkdownBase | null): number {
    const headers = splitTableRow(lines[i]!);
    const aligns = splitTableRow(lines[i + 1]!).map((c) =>
      c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''
    );
    const table = document.createElement('table');
    const addRow = (cells: string[], tag: 'th' | 'td', parent: HTMLElement) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < headers.length; c++) {
        const cell = document.createElement(tag);
        if (aligns[c]) cell.style.textAlign = aligns[c]!;
        inline(cells[c] ?? '', cell, base);
        tr.appendChild(cell);
      }
      parent.appendChild(tr);
    };
    const thead = document.createElement('thead');
    addRow(headers, 'th', thead);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    i += 2;
    while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
      addRow(splitTableRow(lines[i]!), 'td', tbody);
      i++;
    }
    table.appendChild(tbody);
    out.appendChild(table);
    return i;
  }

  function parseList(lines: string[], i: number, out: HTMLElement, base: MarkdownBase | null): number {
    const first = LIST_ITEM.exec(lines[i]!)!;
    const ordered = /\d/.test(first[2]![0]!);
    const list = document.createElement(ordered ? 'ol' : 'ul');
    if (ordered) {
      const start = parseInt(first[2]!, 10);
      if (start !== 1) list.setAttribute('start', String(start));
    }
    while (i < lines.length) {
      const it = LIST_ITEM.exec(lines[i]!);
      if (!it || /\d/.test(it[2]![0]!) !== ordered) break;
      const indent = it[1]!.length + it[2]!.length + Math.min(it[3]!.length, 4);
      const body: string[] = [it[4]!];
      i++;
      while (i < lines.length) {
        const ln = lines[i]!;
        if (!ln.trim()) {
          // A blank line stays inside the item if more indented content follows.
          let j = i;
          while (j < lines.length && !lines[j]!.trim()) j++;
          if (j < lines.length && leadingSpaces(lines[j]!) >= indent) {
            body.push('');
            i++;
            continue;
          }
          break;
        }
        if (leadingSpaces(ln) >= indent) {
          body.push(ln.slice(indent));
          i++;
          continue;
        }
        break;
      }
      const li = document.createElement('li');
      const task = /^\[([ xX])\] +/.exec(body[0]!);
      if (task) {
        body[0] = body[0]!.slice(task[0].length);
        li.className = 'md-task';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.disabled = true;
        cb.checked = task[1] !== ' ';
        li.appendChild(cb);
        li.appendChild(document.createTextNode(' '));
      }
      blocks(body, li, base);
      // Tight-list rendering: the item's first paragraph loses its <p> margins.
      const firstP = li.querySelector(':scope > p');
      if (firstP) {
        while (firstP.firstChild) li.insertBefore(firstP.firstChild, firstP);
        firstP.remove();
      }
      list.appendChild(li);
    }
    out.appendChild(list);
    return i;
  }

  function blocks(lines: string[], out: HTMLElement, base: MarkdownBase | null): void {
    let i = 0;
    while (i < lines.length) {
      if (!lines[i]!.trim()) {
        i++;
        continue;
      }
      i = blockAt(lines, i, out, base);
    }
  }

  // Render exactly one top-level block starting at `i` (assumed non-blank)
  // into `out`, returning the index just past it. Factored out of `blocks`
  // so the diff view can find block boundaries by reusing this directly.
  function blockAt(lines: string[], i: number, out: HTMLElement, base: MarkdownBase | null): number {
    {
      const line = lines[i]!;
      let m: RegExpExecArray | null;

      if ((m = FENCE_OPEN.exec(line))) {
        const fence = m[1]!;
        const lang = m[2]!;
        const buf: string[] = [];
        i++;
        while (i < lines.length) {
          const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]!);
          if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) {
            i++;
            break;
          }
          buf.push(lines[i]!);
          i++;
        }
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        if (lang) code.dataset.lang = lang;
        code.textContent = buf.join('\n');
        pre.appendChild(code);
        out.appendChild(pre);
        return i;
      }
      if ((m = HEADING.exec(line))) {
        const h = document.createElement('h' + m[1]!.length);
        inline(m[2]!.replace(/\s+#+\s*$/, ''), h, base);
        out.appendChild(h);
        return i + 1;
      }
      if (HR.test(line)) {
        out.appendChild(document.createElement('hr'));
        return i + 1;
      }
      if (QUOTE.test(line)) {
        const buf: string[] = [];
        while (i < lines.length && QUOTE.test(lines[i]!)) {
          buf.push(lines[i]!.replace(QUOTE, ''));
          i++;
        }
        const bq = document.createElement('blockquote');
        blocks(buf, bq, base);
        out.appendChild(bq);
        return i;
      }
      if (LIST_ITEM.test(line)) {
        return parseList(lines, i, out, base);
      }
      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
        return parseTable(lines, i, out, base);
      }
      // Paragraph: gather until a blank line or the start of another block.
      const buf: string[] = [line];
      i++;
      while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!)) {
        buf.push(lines[i]!);
        i++;
      }
      const p = document.createElement('p');
      inline(buf.join('\n'), p, base);
      out.appendChild(p);
      return i;
    }
  }

  // ------------------------------------------------------------ diff view

  // Split into top-level blocks, each rendered into its own wrapper element,
  // by reusing blockAt (the exact same code path renderMarkdownInto uses)
  // so a diffed render can never drift from a plain render.
  function splitTopBlocks(lines: string[], base: MarkdownBase | null): { text: string; node: HTMLElement }[] {
    const result: { text: string; node: HTMLElement }[] = [];
    let i = 0;
    while (i < lines.length) {
      if (!lines[i]!.trim()) {
        i++;
        continue;
      }
      const start = i;
      const wrapper = document.createElement('div');
      i = blockAt(lines, i, wrapper, base);
      result.push({ text: lines.slice(start, i).join('\n'), node: wrapper });
    }
    return result;
  }

  // Longest-common-subsequence diff over block source text: block-level
  // granularity, not line/word — an edited paragraph shows as one removed
  // block plus one added block rather than a fine-grained inline diff.
  function diffBlocks<T extends { text: string }>(
    oldBlocks: T[],
    newBlocks: T[]
  ): Array<{ kind: 'same' | 'removed' | 'added'; block: T }> {
    const n = oldBlocks.length;
    const m = newBlocks.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let a = n - 1; a >= 0; a--) {
      for (let b = m - 1; b >= 0; b--) {
        dp[a]![b] =
          oldBlocks[a]!.text === newBlocks[b]!.text
            ? dp[a + 1]![b + 1]! + 1
            : Math.max(dp[a + 1]![b]!, dp[a]![b + 1]!);
      }
    }
    const ops: Array<{ kind: 'same' | 'removed' | 'added'; block: T }> = [];
    let a = 0;
    let b = 0;
    while (a < n && b < m) {
      if (oldBlocks[a]!.text === newBlocks[b]!.text) {
        ops.push({ kind: 'same', block: newBlocks[b]! });
        a++;
        b++;
      } else if (dp[a + 1]![b]! >= dp[a]![b + 1]!) {
        ops.push({ kind: 'removed', block: oldBlocks[a]! });
        a++;
      } else {
        ops.push({ kind: 'added', block: newBlocks[b]! });
        b++;
      }
    }
    while (a < n) {
      ops.push({ kind: 'removed', block: oldBlocks[a]! });
      a++;
    }
    while (b < m) {
      ops.push({ kind: 'added', block: newBlocks[b]! });
      b++;
    }
    return ops;
  }

  // ------------------------------------------------------------ public api

  // Unified diff: one flowing document, in new-document order, with
  // untouched blocks unchanged, edited/removed blocks (rendered from the old
  // text) tinted red, and added blocks tinted green.
  function renderMarkdownDiffInto(
    container: HTMLElement,
    oldSrc: string,
    newSrc: string,
    base: MarkdownBase | null
  ): void {
    container.textContent = '';
    const oldBlocks = splitTopBlocks(oldSrc.replace(/\r\n?/g, '\n').split('\n'), base);
    const newBlocks = splitTopBlocks(newSrc.replace(/\r\n?/g, '\n').split('\n'), base);
    for (const op of diffBlocks(oldBlocks, newBlocks)) {
      op.block.node.classList.add('md-block');
      if (op.kind !== 'same') op.block.node.classList.add(op.kind === 'added' ? 'md-added' : 'md-removed');
      container.appendChild(op.block.node);
    }
  }

  // Plain render of one side (no diff coloring), full width.
  function renderMarkdownInto(container: HTMLElement, src: string, base: MarkdownBase | null): void {
    container.textContent = '';
    blocks(src.replace(/\r\n?/g, '\n').split('\n'), container, base);
  }

  return { renderMarkdownDiffInto, renderMarkdownInto };
})();

const renderMarkdownDiffInto = markdownRenderer.renderMarkdownDiffInto;
const renderMarkdownInto = markdownRenderer.renderMarkdownInto;
