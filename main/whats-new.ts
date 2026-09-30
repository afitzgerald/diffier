'use strict';

/* Release notes, shown once after an update and from Help → What's New.

   The Release workflow bakes them into the app as WhatsNew.md
   (scripts/release_notes.sh): GitHub's generated notes for this release and
   the nine before it, each under a `# vX.Y.Z` line, newest first. Every merge
   to main is its own patch release, so an update that skips a few would
   otherwise show only the last PR. Baked rather than fetched: works offline
   and always matches the build. A local build has no file, so it never shows
   anything and never marks a version seen.

   Zero Node deps, so test/whats-new.test.ts can exercise it directly. */

import type { WhatsNewRelease } from './api-types';

const newer = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }) > 0;

// GitHub's generated-notes markdown cut down to what a user reads: the `###`
// categories from .github/release.yml and their bullets, minus the
// " by @author in <PR url>" tail. "New Contributors" and "Full Changelog" go.
export function parse(markdown: string): WhatsNewRelease[] {
  const releases: WhatsNewRelease[] = [];
  let skipping = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    const cur = releases[releases.length - 1];
    if (line.startsWith('# ')) {
      releases.push({ version: line.slice(2).replace(/^v/, ''), sections: [] });
      skipping = false;
    } else if (line.startsWith('## ')) {
      skipping = line === '## New Contributors';
    } else if (skipping || !cur) {
      continue;
    } else if (line.startsWith('### ')) {
      cur.sections.push({ title: line.slice(4), items: [] });
    } else if (line.startsWith('* ') || line.startsWith('- ')) {
      // A release from before .github/release.yml has no categories.
      if (!cur.sections.length) cur.sections.push({ title: '', items: [] });
      cur.sections[cur.sections.length - 1].items.push(line.slice(2).replace(/ by @\S+ in \S+$/, ''));
    }
  }
  return releases
    .map((r) => ({ ...r, sections: r.sections.filter((s) => s.items.length) }))
    .filter((r) => r.sections.length);
}

// The releases newer than `seen`, up to the running one. Nothing seen yet — a
// fresh install, or the first update to a version with this dialog — shows
// the running release alone rather than the whole baked history.
export function releasesAfter(all: WhatsNewRelease[], seen: string | undefined, current: string): WhatsNewRelease[] {
  if (seen === undefined) return all.filter((r) => r.version === current);
  return all.filter((r) => newer(r.version, seen) && !newer(r.version, current));
}
