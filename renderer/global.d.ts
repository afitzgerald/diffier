/*
 * Ambient globals for the renderer. renderer/app/*.ts and renderer/languages.ts
 * are classic <script> files with no import/export — TypeScript merges them
 * into one global scope for type-checking (see CLAUDE.md), so declarations
 * here are visible everywhere in that program without any file importing
 * this one directly.
 *
 * This file itself uses `import type` (type-only, erased at compile time —
 * no runtime module is created), which technically makes it a "module" to
 * TypeScript; `declare global { ... }` re-opens the ambient global scope
 * from inside it. This is the standard pattern for typing pre-existing
 * globals from a real library's own .d.ts. Domain types (FileEntry,
 * StatusResult, Theme, ...) are aliased here too, so every renderer script
 * can reference them as bare names, matching how they reference `state`/`$`.
 * (`type X = X` below is not self-referential: the right-hand side resolves
 * to this file's module-scope import, the left-hand side declares a new
 * ambient global binding of the same name.)
 */

import type {
  DiffierApi,
  CommitOptions as CommitOptions_,
  ConfirmOptions as ConfirmOptions_,
  RepoInfo as RepoInfo_,
  RollbackTarget as RollbackTarget_,
  Settings as Settings_,
} from '../main/api-types';
import type {
  AheadBehind as AheadBehind_,
  BlameLine as BlameLine_,
  BranchEntry as BranchEntry_,
  BranchesResult as BranchesResult_,
  ChangeType as ChangeType_,
  CommitDetails as CommitDetails_,
  CommitFile as CommitFile_,
  ConflictInfoResult as ConflictInfoResult_,
  DiffPayload as DiffPayload_,
  DiffStat as DiffStat_,
  FileDiffResult as FileDiffResult_,
  FileEntry as FileEntry_,
  ImageDataResult as ImageDataResult_,
  LogEntry as LogEntry_,
  LogOptions as LogOptions_,
  PartialCommitFile as PartialCommitFile_,
  StashEntry as StashEntry_,
  StatusResult as StatusResult_,
} from '../main/git-types';
import type {
  ActionId as ActionId_,
  Binding as Binding_,
  KeymapAction as KeymapAction_,
  KeymapOverrides as KeymapOverrides_,
} from '../main/keymap-types';
import type { Theme as Theme_, ThemeId as ThemeId_, ThemeStyle as ThemeStyle_ } from '../main/themes';

declare global {
  // The `monaco` namespace/global itself comes from monaco-editor's own
  // monaco.d.ts (included directly in tsconfig.renderer.json — it's an
  // ambient global-script .d.ts, not an ES module, so `import type` can't
  // reach it): the AMD loader (renderer/index.html) assigns the real
  // namespace to `window.monaco` once `require(['vs/editor/editor.main'])`
  // resolves. monaco.d.ts also declares `Window.MonacoEnvironment`.

  interface Window {
    api: DiffierApi;
    DiffierLanguages: {
      EXTRA_LANGUAGES: unknown[];
      SHIKI_ONLY_LANGUAGES: { id: string; extensions: string[] }[];
      SHIKI_LANGUAGES: { id: string; extensions: string[]; filenames?: string[] }[];
      EXTENSION_ALIASES: Record<string, string>;
      FILENAME_ALIASES: Record<string, string>;
      SHEBANGS: [RegExp, string][];
      // `typeof monaco` (the ambient global from monaco-editor's own
      // monaco.d.ts, included directly in tsconfig.renderer.json) — not
      // `typeof import('monaco-editor')`, a structurally similar but
      // non-identical ESM declaration that the real runtime global isn't
      // assignable to (distinct enum/branded types between the two).
      register(monacoNs: typeof monaco): void;
      detect(monacoNs: typeof monaco, filePath: string, content?: string | null): string;
    };
    DiffierShiki?: {
      // Raw shiki/TextMate theme JSON — see theme.ts's ShikiThemeInput for
      // the exact shape (distinct from Monaco's own IStandaloneThemeData).
      init(monacoNs: typeof monaco, themes: unknown[]): Promise<string[]>;
    };
    __shikiActive?: boolean;
    // Set by renderer/mermaid.js (built from mermaid-entry.ts) once
    // markdown.ts lazily loads it — see markdown.ts's loadMermaid().
    DiffierMermaid?: {
      render(source: string): Promise<string>;
    };
  }

  // AMD loader shim (renderer/index.html loads monaco-editor/min/vs/loader.js
  // as a classic script, which defines these globally).
  function require(
    deps: string[],
    callback: (...modules: unknown[]) => void,
    errback?: (err: unknown) => void
  ): void;
  namespace require {
    function config(opts: { paths: Record<string, string> }): void;
  }

  // Domain types shared with the main process, re-declared as bare ambient
  // globals so every renderer script can use them without importing.
  type AheadBehind = AheadBehind_;
  type BlameLine = BlameLine_;
  type BranchEntry = BranchEntry_;
  type BranchesResult = BranchesResult_;
  type ChangeType = ChangeType_;
  type CommitDetails = CommitDetails_;
  type CommitFile = CommitFile_;
  type CommitOptions = CommitOptions_;
  type ConfirmOptions = ConfirmOptions_;
  type ConflictInfoResult = ConflictInfoResult_;
  type DiffPayload = DiffPayload_;
  type DiffStat = DiffStat_;
  type FileDiffResult = FileDiffResult_;
  type FileEntry = FileEntry_;
  type ImageDataResult = ImageDataResult_;
  type LogEntry = LogEntry_;
  type LogOptions = LogOptions_;
  type PartialCommitFile = PartialCommitFile_;
  type RepoInfo = RepoInfo_;
  type RollbackTarget = RollbackTarget_;
  type Settings = Settings_;
  type StashEntry = StashEntry_;
  type StatusResult = StatusResult_;
  type ActionId = ActionId_;
  type Binding = Binding_;
  type KeymapAction = KeymapAction_;
  type KeymapOverrides = KeymapOverrides_;
  type Theme = Theme_;
  type ThemeId = ThemeId_;
  type ThemeStyle = ThemeStyle_;
}

export {};
