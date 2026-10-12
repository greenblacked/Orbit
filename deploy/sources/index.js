// The registry of source adapters. The Worker and the snapshot script iterate this list,
// so adding a vendor is one new file in this directory and one line here.
//
// Each adapter is { id, vendor, urls, parse }:
//   id      a stable name, written into every release as `source` and used as the cache key
//   vendor  the maker whose releases it reads; the value of `?vendor=` on the API
//   urls    the allowlist of https URLs the Worker may fetch for it
//   parse   (text, url) => releases, with no I/O; `url` is the document's own URL, for a source
//           whose documents differ only by where they were fetched from

import android from './android.js';
import apple from './apple.js';
import mikrotik from './mikrotik.js';

export const SOURCES = [apple, mikrotik, android];

/** True when `source` has the shape the Worker relies on. */
export function isSource(source) {
  return Boolean(
    source &&
      typeof source.id === 'string' &&
      source.id &&
      typeof source.vendor === 'string' &&
      source.vendor &&
      Array.isArray(source.urls) &&
      source.urls.length > 0 &&
      source.urls.every((url) => typeof url === 'string' && url.startsWith('https://')) &&
      typeof source.parse === 'function',
  );
}

/** The distinct vendors of a list of sources. */
export function vendorsOf(sources = SOURCES) {
  return [...new Set(sources.map((source) => source.vendor))];
}
