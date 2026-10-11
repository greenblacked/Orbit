// The Apple adapter: Apple Developer Releases, an RSS feed of OS builds.
//
// An adapter is { id, vendor, urls, parse }. `urls` is the allowlist: the Worker fetches
// these URLs and no others. `parse(text)` turns one fetched document into releases of the
// contract in ../releases.js, newest first. It does no I/O.

import { familyIds } from '../families.js';
import { field, isHttpsOn, mergeReleases, parseDate, rssItems } from '../releases.js';

export const ID = 'apple-developer-releases';
export const VENDOR = 'apple';
export const FEED_URL = 'https://developer.apple.com/news/releases/rss/releases.rss';
export const FAMILIES = familyIds(VENDOR);

const TITLE_RE = new RegExp(
  `^(${FAMILIES.join('|')})\\s+(\\d+(?:\\.\\d+)*)` +
    '(?:\\s+(beta|RC)(?:\\s+(\\d+))?)?' +
    '(?:\\s*\\(([^()]+)\\))?$',
  'i',
);

/** Parse a release title such as "iOS 27.2 beta 3 (24B5099f)"; null for anything else. */
export function parseTitle(title) {
  const m = TITLE_RE.exec(String(title ?? '').trim());
  if (!m) return null;
  const family = FAMILIES.find((name) => name.toLowerCase() === m[1].toLowerCase());
  const kind = m[3] ? m[3].toLowerCase() : null;
  return {
    vendor: VENDOR,
    family,
    version: m[2],
    major: Number(m[2].split('.')[0]),
    stage: kind === 'beta' ? 'beta' : kind === 'rc' ? 'rc' : 'release',
    beta: m[4] === undefined ? null : Number(m[4]),
    build: m[5] ? m[5].trim() : '',
  };
}

/** Releases of the Apple families in an RSS document, newest first. */
export function parseFeed(xmlText) {
  const releases = [];
  for (const item of rssItems(xmlText)) {
    const title = field(item, 'title');
    const parsed = parseTitle(title);
    if (!parsed) continue;
    const link = field(item, 'link');
    const id = field(item, 'guid') || link;
    const date = parseDate(field(item, 'pubDate'));
    if (!id || !date || !isHttpsOn(link, 'developer.apple.com')) continue;
    releases.push({ id, ...parsed, title, date, url: link, source: ID });
  }
  return mergeReleases([], releases);
}

export default {
  id: ID,
  vendor: VENDOR,
  urls: [FEED_URL],
  parse: parseFeed,
};
