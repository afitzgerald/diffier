'use strict';

import assert from 'assert';
import { parse, releasesAfter } from '../main/whats-new';

const all = parse(`
# v0.0.10
<!-- Release notes generated using configuration in .github/release.yml at main -->

## What's Changed
### New
* Find in the \`markdown\` preview by @afitzgerald in https://github.com/o/r/pull/82
### Fixed
* Keep the blame gutter aligned by @someone-else in https://github.com/o/r/pull/81
### Empty
## New Contributors
* @someone-else made their first contribution in https://github.com/o/r/pull/81

**Full Changelog**: https://github.com/o/r/compare/v0.0.9...v0.0.10

# v0.0.9
## What's Changed

# v0.0.8
## What's Changed
* One by @a in https://x/1
`);

assert.deepStrictEqual(all, [
  {
    version: '0.0.10',
    sections: [
      { title: 'New', items: ['Find in the `markdown` preview'] },
      { title: 'Fixed', items: ['Keep the blame gutter aligned'] },
    ],
  },
  // 0.0.9 was all `internal`, so it is not here.
  { version: '0.0.8', sections: [{ title: '', items: ['One'] }] },
]);
assert.deepStrictEqual(parse('* before any version\n**Full Changelog**: https://x'), []);

const versions = (seen: string | undefined, current: string) =>
  releasesAfter(all, seen, current).map((r) => r.version);
// Numeric, not lexical: "0.0.10" sorts before "0.0.8" as text.
assert.deepStrictEqual(versions('0.0.7', '0.0.10'), ['0.0.10', '0.0.8']);
assert.deepStrictEqual(versions('0.0.8', '0.0.10'), ['0.0.10']);
assert.deepStrictEqual(versions('0.0.10', '0.0.10'), []);
assert.deepStrictEqual(versions(undefined, '0.0.10'), ['0.0.10']);
// An all-internal running release has nothing to say to a new install.
assert.deepStrictEqual(versions(undefined, '0.0.9'), []);
// "0" is older than everything: the whole history, for Help → What's New.
assert.deepStrictEqual(versions('0', '0.0.10'), ['0.0.10', '0.0.8']);

console.log('whats-new tests passed');
