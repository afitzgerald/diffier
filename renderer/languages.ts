'use strict';

/*
 * Extended language support for syntax highlighting.
 *
 * Monaco's bundled "basic languages" cover ~80 languages; this module fills
 * the everyday gaps four ways:
 *   1. Shiki (renderer/highlighter-entry.ts, bundled to highlighter.js) —
 *      TextMate grammars for the SHIKI_LANGUAGES below, tokenized with
 *      shiki's JavaScript regex engine and wired into Monaco via
 *      @shikijs/monaco. Ids follow shiki's canonical names.
 *   2. EXTRA_LANGUAGES — hand-written Monarch grammars for a subset of the
 *      same ids (TOML, Makefile, CMake, Groovy, Haskell, Erlang, Zig, Nix,
 *      LaTeX, unified diff, Elm, OCaml). These are the fallback when the
 *      shiki bundle hasn't been built; when shiki is active its tokens
 *      provider overrides these (same ids, last registration wins).
 *   3. Aliases — file extensions/names mapped onto existing grammars
 *      (Gemfile → ruby, .gitignore → ini, and .vue/.svelte → html when
 *      shiki's real Vue/Svelte grammars are unavailable).
 *   4. Shebang detection — extensionless scripts identified by #! line.
 *
 * Monarch token names reuse the classes every Diffier theme colors: keyword,
 * string, number, comment, type, tag (plus base-theme 'invalid' for deleted
 * diff lines). Loaded as a plain script in the renderer (classic <script>,
 * global scope) and require()d by tests and the shiki bundle build — the UMD
 * check below picks the right shape for whichever context loaded it.
 */

// This file runs as a browser global script, a CommonJS module (tests), and
// an esbuild-bundled ES import (the shiki entry), so `module` may or may not
// exist at runtime. `declare` at top level is visible to every other
// renderer global script in this program (same mechanism that shares
// `state`/`$` across them) — harmless here since nothing else references
// `module`, and TypeScript still requires a real guard at any use site.
declare const module: { exports?: unknown } | undefined;

(function (global: typeof globalThis) {
  // References the ambient global `monaco` namespace (monaco-editor's own
  // monaco.d.ts, included directly in tsconfig.renderer.json) — NOT
  // `typeof import('monaco-editor')`, which resolves to a separate ESM
  // declaration file with structurally similar but non-identical types
  // (distinct enum/branded types), incompatible with the real runtime
  // global this app actually uses.
  type Monaco = typeof monaco;
  type MonarchTokenizer = monaco.languages.IMonarchLanguageRule[];

  interface ExtraLanguage {
    id: string;
    extensions: string[];
    filenames?: string[];
    tokenizer: Record<string, MonarchTokenizer>;
  }

  interface LanguageMeta {
    id: string;
    extensions: string[];
    filenames?: string[];
  }

  const EXTRA_LANGUAGES: ExtraLanguage[] = [
    {
      id: 'toml',
      extensions: ['.toml'],
      filenames: ['Cargo.lock'],
      tokenizer: {
        root: [
          [/^\s*#.*$/, 'comment'],
          [/^\s*\[\[?[^\]]*\]\]?/, 'type'],
          [/"""/, { token: 'string', next: '@mstring' }],
          [/"([^"\\]|\\.)*"/, 'string'],
          [/'[^']*'/, 'string'],
          [/\b(true|false)\b/, 'keyword'],
          [/\d{4}-\d{2}-\d{2}([Tt ][\d:.]+([Zz]|[+-][\d:]+)?)?/, 'number'],
          [/[+-]?(0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(\.[\d_]+)?([eE][+-]?\d+)?)/, 'number'],
          [/#.*$/, 'comment'],
        ],
        mstring: [
          [/"""/, { token: 'string', next: '@pop' }],
          [/[^"]+/, 'string'],
          [/"/, 'string'],
        ],
      },
    },
    {
      id: 'make',
      extensions: ['.mk', '.mak'],
      filenames: ['Makefile', 'makefile', 'GNUmakefile', 'Justfile', 'justfile'],
      tokenizer: {
        root: [
          [/^#.*$/, 'comment'],
          [/^\.[A-Z_]+\s*:/, 'keyword'],
          [/^[A-Za-z_][\w.-]*\s*[:?+!]?=/, 'type'],
          [/^[^\t\s:=#][^:=#]*:(?!=)/, 'type'],
          [/\$[({][\w.<@^%*?]+[)}]/, 'keyword'],
          [/\$[<@^%*?]/, 'keyword'],
          [/#.*$/, 'comment'],
          [/"([^"\\]|\\.)*"/, 'string'],
          [/'[^']*'/, 'string'],
        ],
      },
    },
    {
      id: 'cmake',
      extensions: ['.cmake'],
      filenames: ['CMakeLists.txt'],
      tokenizer: {
        root: [
          [/#.*$/, 'comment'],
          [/^\s*[A-Za-z_]\w*(?=\s*\()/, 'keyword'],
          [/\$\{\w+\}/, 'type'],
          [/"([^"\\]|\\.)*"/, 'string'],
          [/\b(ON|OFF|TRUE|FALSE|NOTFOUND)\b/, 'number'],
        ],
      },
    },
    {
      id: 'groovy',
      extensions: ['.groovy', '.gradle', '.gvy'],
      filenames: ['Jenkinsfile'],
      tokenizer: {
        root: [
          [/\/\/.*$/, 'comment'],
          [/\/\*/, { token: 'comment', next: '@comment' }],
          [/@[A-Za-z_]\w*/, 'tag'],
          [/"""/, { token: 'string', next: '@tdstring' }],
          [/'''/, { token: 'string', next: '@tsstring' }],
          [/"([^"\\]|\\.)*"/, 'string'],
          [/'([^'\\]|\\.)*'/, 'string'],
          [/\b(abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|def|default|do|double|else|enum|extends|final|finally|float|for|goto|if|implements|import|in|instanceof|int|interface|long|native|new|package|private|protected|public|return|short|static|super|switch|synchronized|this|throw|throws|trait|transient|try|var|void|volatile|while|true|false|null|as)\b/, 'keyword'],
          [/\b\d[\d_]*(\.[\d_]+)?([eE][+-]?\d+)?[LlFfDdGg]?\b/, 'number'],
        ],
        comment: [
          [/[^/*]+/, 'comment'],
          [/\*\//, { token: 'comment', next: '@pop' }],
          [/[/*]/, 'comment'],
        ],
        tdstring: [
          [/"""/, { token: 'string', next: '@pop' }],
          [/[^"]+/, 'string'],
          [/"/, 'string'],
        ],
        tsstring: [
          [/'''/, { token: 'string', next: '@pop' }],
          [/[^']+/, 'string'],
          [/'/, 'string'],
        ],
      },
    },
    {
      id: 'haskell',
      extensions: ['.hs'],
      tokenizer: {
        root: [
          [/--.*$/, 'comment'],
          [/\{-/, { token: 'comment', next: '@comment' }],
          [/"([^"\\]|\\.)*"/, 'string'],
          [/'([^'\\]|\\.)'/, 'string'],
          [/\b(module|where|import|qualified|hiding|data|type|newtype|class|instance|deriving|do|case|of|let|in|if|then|else|infixl|infixr|infix|foreign|default)\b/, 'keyword'],
          [/\b[A-Z][\w']*/, 'type'],
          [/\b\d+(\.\d+)?([eE][+-]?\d+)?\b/, 'number'],
        ],
        comment: [
          [/\{-/, { token: 'comment', next: '@push' }],
          [/-\}/, { token: 'comment', next: '@pop' }],
          [/[^{-]+/, 'comment'],
          [/./, 'comment'],
        ],
      },
    },
    {
      id: 'erlang',
      extensions: ['.erl', '.hrl'],
      tokenizer: {
        root: [
          [/%.*$/, 'comment'],
          [/^-[a-z]\w*/, 'type'],
          [/"([^"\\]|\\.)*"/, 'string'],
          [/\$\\?./, 'string'],
          [/\b(after|begin|case|catch|cond|end|fun|if|of|receive|try|when|andalso|orelse|band|bor|bxor|bnot|div|rem|not|and|or|xor)\b/, 'keyword'],
          [/\b[A-Z_][\w@]*/, 'type'],
          [/\b\d+(#[\da-fA-F]+)?(\.\d+)?([eE][+-]?\d+)?\b/, 'number'],
        ],
      },
    },
    {
      id: 'zig',
      extensions: ['.zig', '.zon'],
      tokenizer: {
        root: [
          [/\/\/.*$/, 'comment'],
          [/@[A-Za-z_]\w*/, 'type'],
          [/\\\\.*$/, 'string'],
          [/"([^"\\]|\\.)*"/, 'string'],
          [/'([^'\\]|\\.)*'/, 'string'],
          [/\b(const|var|fn|pub|return|if|else|while|for|switch|defer|errdefer|try|catch|orelse|unreachable|struct|enum|union|error|comptime|inline|export|extern|test|break|continue|and|or|usingnamespace|async|await|suspend|resume|threadlocal|volatile|allowzero|packed|linksection|callconv|noalias|anytype|anyframe|null|undefined|true|false)\b/, 'keyword'],
          [/\b(i\d+|u\d+|f16|f32|f64|f80|f128|isize|usize|bool|void|type|noreturn|c_int|c_uint|c_char)\b/, 'type'],
          [/\b(0x[\da-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(\.[\d_]*)?([eE][+-]?\d+)?)\b/, 'number'],
        ],
      },
    },
    {
      id: 'nix',
      extensions: ['.nix'],
      tokenizer: {
        root: [
          [/#.*$/, 'comment'],
          [/\/\*/, { token: 'comment', next: '@comment' }],
          [/\b(let|in|rec|with|inherit|assert|if|then|else|or|import|builtins|derivation)\b/, 'keyword'],
          [/\b(true|false|null)\b/, 'keyword'],
          [/''/, { token: 'string', next: '@istring' }],
          [/"/, { token: 'string', next: '@dstring' }],
          [/\b\d+(\.\d+)?\b/, 'number'],
          [/<[^>]+>/, 'type'],
        ],
        comment: [
          [/[^/*]+/, 'comment'],
          [/\*\//, { token: 'comment', next: '@pop' }],
          [/[/*]/, 'comment'],
        ],
        dstring: [
          [/[^"\\$]+/, 'string'],
          [/\\./, 'string'],
          [/\$\{/, { token: 'type', next: '@interp' }],
          [/\$/, 'string'],
          [/"/, { token: 'string', next: '@pop' }],
        ],
        istring: [
          [/'''/, 'string'],
          [/''\$/, 'string'],
          [/''/, { token: 'string', next: '@pop' }],
          [/\$\{/, { token: 'type', next: '@interp' }],
          [/[^'$]+/, 'string'],
          [/['$]/, 'string'],
        ],
        interp: [
          [/\}/, { token: 'type', next: '@pop' }],
          [/[^}]+/, ''],
        ],
      },
    },
    {
      id: 'latex',
      extensions: ['.tex', '.sty', '.cls', '.bib'],
      tokenizer: {
        root: [
          [/%.*$/, 'comment'],
          [/\\[a-zA-Z@]+\*?/, 'keyword'],
          [/\\[^a-zA-Z]/, 'keyword'],
          [/\$\$?/, { token: 'string', next: '@math' }],
          [/[{}[\]]/, 'delimiter'],
        ],
        math: [
          [/\$\$?/, { token: 'string', next: '@pop' }],
          [/\\[a-zA-Z@]+/, 'keyword'],
          [/[^$\\]+/, 'string'],
          [/\\./, 'string'],
        ],
      },
    },
    {
      id: 'diff',
      extensions: ['.diff', '.patch'],
      tokenizer: {
        root: [
          [/^(diff|index|new file|deleted file|similarity|rename|copy|Binary).*$/, 'comment'],
          [/^(---|\+\+\+).*$/, 'type'],
          [/^@@.*$/, 'number'],
          [/^\+.*$/, 'string'],
          [/^-.*$/, 'invalid'],
        ],
      },
    },
    {
      id: 'elm',
      extensions: ['.elm'],
      tokenizer: {
        root: [
          [/--.*$/, 'comment'],
          [/\{-/, { token: 'comment', next: '@comment' }],
          [/"([^"\\]|\\.)*"/, 'string'],
          [/'([^'\\]|\\.)'/, 'string'],
          [/\b(module|exposing|import|as|port|type|alias|if|then|else|case|of|let|in)\b/, 'keyword'],
          [/\b[A-Z]\w*/, 'type'],
          [/\b\d+(\.\d+)?([eE][+-]?\d+)?\b/, 'number'],
        ],
        comment: [
          [/\{-/, { token: 'comment', next: '@push' }],
          [/-\}/, { token: 'comment', next: '@pop' }],
          [/[^{-]+/, 'comment'],
          [/./, 'comment'],
        ],
      },
    },
    {
      id: 'ocaml',
      extensions: ['.ml', '.mli'],
      tokenizer: {
        root: [
          [/\(\*/, { token: 'comment', next: '@comment' }],
          [/"([^"\\]|\\.)*"/, 'string'],
          [/\b(let|rec|in|fun|function|match|with|type|module|struct|sig|end|if|then|else|begin|open|include|and|as|assert|class|constraint|do|done|downto|exception|external|for|functor|inherit|initializer|lazy|method|mutable|new|object|of|private|to|try|val|virtual|when|while|true|false)\b/, 'keyword'],
          [/\b[A-Z][\w']*/, 'type'],
          [/\b\d+(\.\d+)?\b/, 'number'],
        ],
        comment: [
          [/\(\*/, { token: 'comment', next: '@push' }],
          [/\*\)/, { token: 'comment', next: '@pop' }],
          [/[^(*]+/, 'comment'],
          [/./, 'comment'],
        ],
      },
    },
  ];

  // Languages provided only by the shiki bundle (TextMate grammars), with
  // the file metadata used to register them in Monaco. Ids are shiki's
  // canonical language ids. EXTRA_LANGUAGES ids are registered with their
  // own metadata, so this lists just the shiki-only additions.
  const SHIKI_ONLY_LANGUAGES: LanguageMeta[] = [
    { id: 'vue', extensions: ['.vue'] },
    { id: 'svelte', extensions: ['.svelte'] },
    { id: 'astro', extensions: ['.astro'] },
    { id: 'crystal', extensions: ['.cr'] },
    { id: 'nim', extensions: ['.nim', '.nims'] },
    { id: 'prisma', extensions: ['.prisma'] },
    { id: 'glsl', extensions: ['.glsl', '.vert', '.frag', '.comp'] },
    { id: 'd', extensions: ['.d', '.di'] },
    { id: 'gleam', extensions: ['.gleam'] },
    { id: 'odin', extensions: ['.odin'] },
    { id: 'purescript', extensions: ['.purs'] },
    { id: 'ada', extensions: ['.adb', '.ads', '.ada'] },
    { id: 'asm', extensions: ['.asm'] },
    { id: 'awk', extensions: ['.awk'] },
    { id: 'haxe', extensions: ['.hx'] },
    { id: 'common-lisp', extensions: ['.lisp', '.cl'] },
    { id: 'racket', extensions: ['.rkt'] },
  ];

  // Everything the shiki bundle should load and register.
  const SHIKI_LANGUAGES: LanguageMeta[] = [
    ...EXTRA_LANGUAGES.map((l) => ({
      id: l.id,
      extensions: l.extensions,
      filenames: l.filenames,
    })),
    ...SHIKI_ONLY_LANGUAGES,
  ];

  // Extensions Monaco doesn't claim, mapped onto grammars it (or we) have.
  // These are consulted only when nothing registered claims the extension —
  // e.g. .vue falls back to the html grammar (which embeds JS/CSS in
  // <script>/<style>) when the shiki bundle with the real Vue grammar is
  // missing.
  const EXTENSION_ALIASES: Record<string, string> = {
    '.vue': 'html',
    '.svelte': 'html',
    '.astro': 'html',
    '.cjs': 'javascript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.properties': 'ini',
    '.editorconfig': 'ini',
    '.conf': 'ini',
    '.rake': 'ruby',
    '.gemspec': 'ruby',
    '.podspec': 'ruby',
    '.plist': 'xml',
    '.csproj': 'xml',
    '.props': 'xml',
    '.storyboard': 'xml',
    '.xib': 'xml',
  };

  // Well-known filenames (keys lowercased) → language id.
  const FILENAME_ALIASES: Record<string, string> = {
    gemfile: 'ruby',
    rakefile: 'ruby',
    vagrantfile: 'ruby',
    podfile: 'ruby',
    brewfile: 'ruby',
    fastfile: 'ruby',
    procfile: 'yaml',
    build: 'python',
    workspace: 'python',
    'build.bazel': 'python',
    'workspace.bazel': 'python',
    '.bazelrc': 'ini',
    '.gitignore': 'ini',
    '.gitattributes': 'ini',
    '.gitmodules': 'ini',
    '.dockerignore': 'ini',
    '.npmignore': 'ini',
    '.npmrc': 'ini',
    '.editorconfig': 'ini',
    '.prettierrc': 'json',
    '.eslintrc': 'json',
    '.babelrc': 'json',
  };

  // Interpreter → language for extensionless scripts with a #! first line.
  const SHEBANGS: [RegExp, string][] = [
    [/\b(?:bash|sh|zsh|ksh|dash|fish)\b/, 'shell'],
    [/python/, 'python'],
    [/\b(?:node|deno|bun)\b/, 'javascript'],
    [/ruby/, 'ruby'],
    [/perl/, 'perl'],
    [/php/, 'php'],
    [/pwsh|powershell/, 'powershell'],
    [/escript/, 'erlang'],
  ];

  function register(monaco: Monaco): void {
    for (const lang of EXTRA_LANGUAGES) {
      monaco.languages.register({
        id: lang.id,
        extensions: lang.extensions,
        filenames: lang.filenames || [],
      });
      monaco.languages.setMonarchTokensProvider(lang.id, {
        defaultToken: '',
        tokenizer: lang.tokenizer,
      });
    }
  }

  // Resolve a language id for a repo path, optionally sniffing the content's
  // first line for a shebang. Registry lookups are case-insensitive (Monaco's
  // own resolution is case-sensitive on filenames — "dockerfile" would miss).
  function detect(monaco: Monaco, filePath: string, content?: string | null): string {
    const base = filePath.split('/').pop()!;
    const lbase = base.toLowerCase();
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot).toLowerCase() : '';
    const langs = monaco.languages.getLanguages();

    for (const l of langs) {
      if (l.filenames && l.filenames.some((f) => f.toLowerCase() === lbase)) return l.id;
    }
    if (FILENAME_ALIASES[lbase]) return FILENAME_ALIASES[lbase];
    if (lbase.startsWith('.env')) return 'ini';

    if (ext) {
      for (const l of langs) {
        if (l.extensions && l.extensions.some((e) => e.toLowerCase() === ext)) return l.id;
      }
      if (EXTENSION_ALIASES[ext]) return EXTENSION_ALIASES[ext];
    }

    const firstLine = String(content || '').slice(0, 256).split('\n', 1)[0]!;
    if (firstLine.startsWith('#!')) {
      for (const [re, id] of SHEBANGS) {
        if (re.test(firstLine)) return id;
      }
    }
    return 'plaintext';
  }

  const api = {
    EXTRA_LANGUAGES,
    SHIKI_ONLY_LANGUAGES,
    SHIKI_LANGUAGES,
    EXTENSION_ALIASES,
    FILENAME_ALIASES,
    SHEBANGS,
    register,
    detect,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (global as typeof globalThis & { DiffierLanguages?: typeof api }).DiffierLanguages = api;
})(typeof window !== 'undefined' ? window : globalThis);
