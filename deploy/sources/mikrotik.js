// The MikroTik adapter: RouterOS 7 from MikroTik's own upgrade server and release feed.
//
// Two kinds of document, both verified by a read-only probe from a GitHub runner on
// 2026-10-12 (docs/adr/0006-list-vendors-before-their-feeds.md):
//
//   NEWESTa7.<channel>                    plain text, one line "<version> <unix-seconds>", the
//                                         newest RouterOS 7 of one channel (stable, long-term
//                                         or testing). The channel is only in the URL.
//   latest-stable-and-long-term.rss       RSS; items titled "RouterOS <version> [<channel>]"
//                                         linking https://mikrotik.com/download?v=<version>.
//
// An adapter is { id, vendor, urls, parse }; see apple.js. MikroTik has no build ids, so a
// release's build is its version string (the build sigil hashes any string). The RSS item
// body (content:encoded, the release notes) is never read. `parse(text, url)` needs the URL
// of the document, because a NEWEST file does not say which channel it belongs to.

import { familyIds } from '../families.js';
import { field, isHttpsOn, mergeReleases, parseDate, rssItems } from '../releases.js';

export const ID = 'mikrotik-routeros';
export const VENDOR = 'mikrotik';
export const FAMILY = 'RouterOS';
export const FAMILIES = familyIds(VENDOR);

export const RSS_URL = 'https://download.mikrotik.com/routeros/latest-stable-and-long-term.rss';
export const NEWEST_URLS = {
  stable: 'https://upgrade.mikrotik.com/routeros/NEWESTa7.stable',
  'long-term': 'https://upgrade.mikrotik.com/routeros/NEWESTa7.long-term',
  testing: 'https://upgrade.mikrotik.com/routeros/NEWESTa7.testing',
};

const HOST = 'mikrotik.com';
const CHANNELS = Object.keys(NEWEST_URLS);
const MAX_TEXT = 256; // a NEWEST document is one short line
const MAX_UNIX = 4102444800; // 2100-01-01: anything later is not a timestamp of ours

const VERSION_RE = /^(\d{1,3})\.(\d{1,3})(?:\.(\d{1,4}))?(?:(rc|beta)(\d{1,3}))?$/;
const LINE_RE = /^(\S+) (\d{1,11})$/;
const TITLE_RE = new RegExp(`^RouterOS (\\S+) \\[(${CHANNELS.join('|')})\\]$`);

/** The download page of one RouterOS version, as the feed links it. */
export const downloadUrl = (version) => `https://mikrotik.com/download?v=${version}`;

/** Unix seconds to ISO-8601 UTC without milliseconds; null when not a plausible time. */
export function unixToIso(seconds) {
  const n = Number(seconds);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_UNIX) return null;
  return new Date(n * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * One release row, or null when the version does not fit its channel. stable and long-term
 * carry a plain version ("7.23.8"); testing carries a pre-release ("7.25rc1", "7.25beta2").
 */
export function makeRelease({ version, channel, date, url }) {
  const m = VERSION_RE.exec(String(version ?? ''));
  if (!m || !CHANNELS.includes(channel) || !date || !FAMILIES.includes(FAMILY)) return null;
  const preRelease = m[4] !== undefined;
  if (preRelease !== (channel === 'testing')) return null;
  const link = url ?? downloadUrl(version);
  if (!isHttpsOn(link, HOST)) return null;
  return {
    id: `routeros-${version}-${channel}`,
    vendor: VENDOR,
    family: FAMILY,
    version,
    major: Number(m[1]),
    stage: preRelease ? (m[4] === 'rc' ? 'rc' : 'beta') : 'release',
    beta: preRelease ? Number(m[5]) : null,
    build: version,
    title: preRelease ? `RouterOS ${version}` : `RouterOS ${version} ${channel}`,
    date,
    url: link,
    source: ID,
  };
}

/** The release in one NEWEST document ("<version> <unix-seconds>") of a channel; [] if malformed. */
export function parseNewest(text, channel) {
  const body = String(text ?? '');
  if (body.length > MAX_TEXT) return [];
  const m = LINE_RE.exec(body.trim());
  if (!m) return [];
  const release = makeRelease({ version: m[1], channel, date: unixToIso(m[2]) });
  return release ? [release] : [];
}

/** Releases of the RouterOS RSS feed, newest first. The item body is never read. */
export function parseFeed(xmlText) {
  const releases = [];
  for (const item of rssItems(xmlText)) {
    const m = TITLE_RE.exec(field(item, 'title'));
    if (!m) continue;
    const release = makeRelease({
      version: m[1],
      channel: m[2],
      date: parseDate(field(item, 'pubDate')),
      url: field(item, 'link'),
    });
    if (release) releases.push(release);
  }
  return mergeReleases([], releases);
}

/** Parse one fetched document; the URL says whether it is the feed or which NEWEST file. */
export function parse(text, url = '') {
  if (url === RSS_URL) return parseFeed(text);
  const channel = CHANNELS.find((name) => NEWEST_URLS[name] === url);
  return channel ? parseNewest(text, channel) : [];
}

export default {
  id: ID,
  vendor: VENDOR,
  // The feed first: where both name a release, the later NEWEST timestamp wins the merge.
  urls: [RSS_URL, ...CHANNELS.map((name) => NEWEST_URLS[name])],
  parse,
};
