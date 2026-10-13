// The registry of security-notes adapters. The snapshot script iterates this list, so adding a
// vendor is one new file in this directory and one line here.
//
// Each adapter is { id, vendor, index, hosts, parseIndex, parseNote, match }:
//   id          a stable name, written into the payload as a source id and as each note's `source`
//   vendor      the maker whose releases it describes; matches `vendor` in releases.json
//   index       the https URL of the vendor's list of security pages
//   hosts       the hosts a note URL may be on; any other URL is refused
//   parseIndex  (html) => rows, with no I/O
//   parseNote   (html) => { title, released, cves, ... } or null, with no I/O
//   match       (releases, rows) => [{ id, status, row }], with no I/O
//   covers      optional (page, release) => boolean: whether a parsed note is the release's own
//   lang        optional { param, value }: a host that picks the language by query parameter (hl=en)
//
// A source with `kind: 'bulletins'` (Android) has another shape, because its releases are joined
// to a monthly page by a patch level and not by an index row:
//   index        the page that holds the patch levels (the AOSP build-numbers page)
//   parseIndex   (html) => Map from a release id to its patch level
//   neededPages  (releases, patchLevels) => the bulletin URLs to read
//   parseBulletin (html) => a parsed bulletin; no parseNote
//   match        (releases, patchLevels, bulletins, checkedAt) => { notes, releases }
//   family       the one family of `vendor` it describes; maxPages the most pages a run reads
// Nothing here runs in the Worker: the payload is parsed offline (ADR 0008).

import android from './android.js';
import apple from './apple.js';

export const SECURITY_SOURCES = [apple, android];

/** True when `source` has the shape the snapshot script relies on. */
export function isSecuritySource(source) {
  return Boolean(
    source &&
      typeof source.id === 'string' &&
      source.id &&
      typeof source.vendor === 'string' &&
      source.vendor &&
      typeof source.index === 'string' &&
      source.index.startsWith('https://') &&
      Array.isArray(source.hosts) &&
      source.hosts.length > 0 &&
      typeof source.parseIndex === 'function' &&
      typeof source.match === 'function' &&
      (source.lang === undefined ||
        Boolean(
          source.lang &&
            typeof source.lang.param === 'string' &&
            source.lang.param &&
            typeof source.lang.value === 'string' &&
            source.lang.value,
        )) &&
      (source.kind === 'bulletins'
        ? typeof source.parseBulletin === 'function' &&
          typeof source.bulletinUrl === 'function' &&
          typeof source.neededPages === 'function' &&
          typeof source.family === 'string'
        : typeof source.parseNote === 'function'),
  );
}
