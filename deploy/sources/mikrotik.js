// The MikroTik adapter: RouterOS 7 from MikroTik's own upgrade server.
//
// One kind of document, verified by a read-only probe from a GitHub runner on 2026-10-12
// (docs/adr/0006-list-vendors-before-their-feeds.md):
//
//   NEWESTa7.<channel>    plain text, one line "<version> <unix-seconds>", the newest
//                         RouterOS 7 of one channel (stable, long-term or testing). The
//                         channel is only in the URL.
//
// The release RSS feed is not read: it names the same versions as the stable and long-term
// files, with a different date, and its failure would fail the whole source. Every date
// therefore comes from one place, the NEWEST timestamps.
//
// An adapter is { id, vendor, urls, parse }; see apple.js. MikroTik has no build ids, so a
// release's build is its version string (the build sigil hashes any string). `parse(text, url)`
// needs the URL of the document, because a NEWEST file does not say which channel it is.

import { familyIds } from '../families.js';

export const ID = 'mikrotik-routeros';
export const VENDOR = 'mikrotik';
export const FAMILY = 'RouterOS';
export const FAMILIES = familyIds(VENDOR);

export const NEWEST_URLS = {
  stable: 'https://upgrade.mikrotik.com/routeros/NEWESTa7.stable',
  'long-term': 'https://upgrade.mikrotik.com/routeros/NEWESTa7.long-term',
  testing: 'https://upgrade.mikrotik.com/routeros/NEWESTa7.testing',
};

const CHANNELS = Object.keys(NEWEST_URLS);
const MAX_TEXT = 256; // a NEWEST document is one short line
const MAX_UNIX = 4102444800; // 2100-01-01: anything later is not a timestamp of ours
const MAX_SKEW_MS = 24 * 60 * 60 * 1000; // a release dated further ahead than this is not believed

const VERSION_RE = /^(\d{1,3})\.(\d{1,3})(?:\.(\d{1,4}))?(?:(rc|beta)(\d{1,3}))?$/;
const LINE_RE = /^(\S+) (\d{1,11})$/;

/** The download page of one RouterOS version. */
export const downloadUrl = (version) => `https://mikrotik.com/download?v=${version}`;

/** Unix seconds to ISO-8601 UTC without milliseconds; null when not a plausible time. */
export function unixToIso(seconds) {
  const n = Number(seconds);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_UNIX) return null;
  return new Date(n * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * One release row, or null when the version does not fit its channel or its date lies in the
 * future. stable and long-term carry a plain version ("7.23.8"); testing carries a
 * pre-release ("7.25rc1", "7.25beta2"), whose `version` is the number alone ("7.25") and
 * whose `build` is the full string. The link is always built from the version.
 */
export function makeRelease({ version, channel, date, now = Date.now() }) {
  const m = VERSION_RE.exec(String(version ?? ''));
  if (!m || !CHANNELS.includes(channel) || !date || !FAMILIES.includes(FAMILY)) return null;
  const preRelease = m[4] !== undefined;
  if (preRelease !== (channel === 'testing')) return null;
  if (Date.parse(date) > now + MAX_SKEW_MS) return null;
  const number = preRelease ? `${m[1]}.${m[2]}${m[3] === undefined ? '' : `.${m[3]}`}` : version;
  return {
    id: `routeros-${version}-${channel}`,
    vendor: VENDOR,
    family: FAMILY,
    version: number,
    major: Number(m[1]),
    stage: preRelease ? (m[4] === 'rc' ? 'rc' : 'beta') : 'release',
    beta: preRelease ? Number(m[5]) : null,
    build: version,
    title: preRelease ? `RouterOS ${version}` : `RouterOS ${version} ${channel}`,
    date,
    url: downloadUrl(version),
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

/** Parse one fetched document; the URL says which NEWEST file it is. */
export function parse(text, url = '') {
  const channel = CHANNELS.find((name) => NEWEST_URLS[name] === url);
  return channel ? parseNewest(text, channel) : [];
}

export default {
  id: ID,
  vendor: VENDOR,
  urls: CHANNELS.map((name) => NEWEST_URLS[name]),
  parse,
};
