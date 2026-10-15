// The release feeds: /api/feed.atom (Atom, RFC 4287) and /api/feed.json (JSON Feed 1.1).
// Pure functions over the combined releases payload, with no I/O, so the Worker and the tests
// share them and the two formats cannot disagree about which releases an entry lists.
//
// Both feeds carry the newest MAX_ENTRIES releases, optionally narrowed by ?vendor=, ?family=
// and ?stage= (an unknown value is a 400, like ?vendor= on /api/releases.json). An entry links
// to its vendor's page only when the host is one the site allows for that vendor, the same rule
// src/assets/releases.js applies to the timeline; otherwise it links to the release's row on the
// site's own timeline. Every text and attribute is XML-escaped; JSON is serialised, not built.
//
// ids and links name the canonical site, not the host the request came in on, so a reader
// that subscribes through stage or workers.dev sees the same entry ids as one on production.

import { FAMILIES, VENDORS } from './families.js';

export const SITE = 'https://orbit.szolotov.com';
export const MAX_ENTRIES = 100;
export const STAGES = ['release', 'beta', 'rc'];
export const ATOM_TYPE = 'application/atom+xml; charset=utf-8';
export const JSON_FEED_TYPE = 'application/feed+json; charset=utf-8';

const TITLE = 'Release Orbit releases';
const SUBTITLE = 'Recent OS releases, betas and release candidates, newest first.';
// An RFC 4151 tag URI: the authority and the year the site began minting ids.
const TAG_PREFIX = 'tag:orbit.szolotov.com,2026:release:';

const FILTERS = ['vendor', 'family', 'stage'];
const PLURAL = { vendor: 'vendors', family: 'families', stage: 'stages' };

/**
 * Read ?vendor=, ?family= and ?stage= from the query. `vendors` is the list the Worker serves.
 * Returns { filters } (only the ones asked for) or { error } with the 400 body to answer.
 */
export function feedQuery(params, vendors) {
  const known = {
    vendor: vendors,
    family: FAMILIES.map((family) => family.id),
    stage: STAGES,
  };
  const filters = {};
  for (const name of FILTERS) {
    if (!params.has(name)) continue;
    const value = params.get(name);
    if (!known[name].includes(value)) {
      return { error: { error: `unknown ${name}`, [PLURAL[name]]: known[name] } };
    }
    filters[name] = value;
  }
  return { filters };
}

/** The query string of the filters, in a fixed order, so equal filters give equal ids. */
function queryOf(filters) {
  const pairs = FILTERS.filter((name) => filters[name] !== undefined).map(
    (name) => `${name}=${encodeURIComponent(filters[name])}`,
  );
  return pairs.length ? `?${pairs.join('&')}` : '';
}

function titleOf(filters) {
  const parts = FILTERS.map((name) => filters[name]).filter((value) => value !== undefined);
  return parts.length ? `${TITLE} (${parts.join(', ')})` : TITLE;
}

/** True when `link` is an https URL on one of the hosts the site allows for `vendor`. */
export function allowedLink(vendor, link) {
  try {
    const { protocol, hostname } = new URL(link);
    const entry = VENDORS.find((v) => v.id === vendor);
    return protocol === 'https:' && Boolean(entry?.source?.hosts?.includes(hostname));
  } catch {
    return false;
  }
}

/** Where an entry points: the vendor's page when allowed, otherwise the site's own timeline. */
export function entryLink(release) {
  return allowedLink(release.vendor, release.url)
    ? new URL(release.url).href
    : `${SITE}/timeline/?id=${encodeURIComponent(release.id)}`;
}

const timeOf = (text) => Date.parse(text);

/** The releases a feed lists: filtered, newest first, at most MAX_ENTRIES, with a valid date. */
export function selectReleases(releases, filters = {}) {
  return releases
    .filter(
      (release) =>
        release &&
        typeof release.id === 'string' &&
        release.id !== '' &&
        Number.isFinite(timeOf(release.date)) &&
        (filters.vendor === undefined || release.vendor === filters.vendor) &&
        (filters.family === undefined || release.family === filters.family) &&
        (filters.stage === undefined || release.stage === filters.stage),
    )
    .sort((a, b) => timeOf(b.date) - timeOf(a.date))
    .slice(0, MAX_ENTRIES);
}

const iso = (text) => new Date(timeOf(text)).toISOString();

// What a reader sees under the title: stage and build, in plain text.
function summaryOf(release) {
  const stage =
    release.stage === 'release'
      ? 'Release'
      : `${release.stage === 'rc' ? 'RC' : 'Beta'}${release.beta ? ` ${release.beta}` : ''}`;
  const build = release.build && release.build !== release.version ? `, build ${release.build}` : '';
  return `${release.family ?? release.vendor} ${release.version ?? ''}: ${stage}${build}`
    .replace(/\s+/g, ' ')
    .trim();
}

// XML 1.0 cannot carry most control characters at all, even escaped: drop them, then escape.
const XML_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;
const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** Text for an XML text node or attribute value. */
export function xmlEscape(value) {
  return String(value ?? '')
    .replace(XML_FORBIDDEN, '')
    .replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

function newest(releases, fallback) {
  const first = releases[0];
  if (first) return iso(first.date);
  return Number.isFinite(timeOf(fallback)) ? iso(fallback) : new Date(Date.now()).toISOString();
}

/** The Atom document for `payload` (the combined releases payload) as { type, body }. */
export function atomFeed(payload, filters = {}) {
  const releases = selectReleases(payload.releases, filters);
  const self = `${SITE}/api/feed.atom${queryOf(filters)}`;
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">',
    `<id>${xmlEscape(self)}</id>`,
    `<title>${xmlEscape(titleOf(filters))}</title>`,
    `<subtitle>${xmlEscape(SUBTITLE)}</subtitle>`,
    `<updated>${newest(releases, payload.fetchedAt)}</updated>`,
    `<link rel="self" type="application/atom+xml" href="${xmlEscape(self)}"/>`,
    `<link rel="alternate" type="text/html" href="${xmlEscape(`${SITE}/timeline/`)}"/>`,
    '<author><name>Release Orbit</name></author>',
  ];
  for (const release of releases) {
    const when = iso(release.date);
    lines.push(
      '<entry>',
      `<id>${xmlEscape(TAG_PREFIX + encodeURIComponent(release.id))}</id>`,
      `<title>${xmlEscape(release.title || summaryOf(release))}</title>`,
      `<link rel="alternate" type="text/html" href="${xmlEscape(entryLink(release))}"/>`,
      `<published>${when}</published>`,
      `<updated>${when}</updated>`,
      ...[release.family, release.stage]
        .filter((term) => typeof term === 'string' && term !== '')
        .map((term) => `<category term="${xmlEscape(term)}"/>`),
      `<summary type="text">${xmlEscape(summaryOf(release))}</summary>`,
      '</entry>',
    );
  }
  lines.push('</feed>', '');
  return { type: ATOM_TYPE, body: lines.join('\n') };
}

/** The JSON Feed 1.1 document for `payload` as { type, body }. */
export function jsonFeed(payload, filters = {}) {
  const releases = selectReleases(payload.releases, filters);
  const feed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: titleOf(filters),
    description: SUBTITLE,
    home_page_url: `${SITE}/timeline/`,
    feed_url: `${SITE}/api/feed.json${queryOf(filters)}`,
    language: 'en',
    authors: [{ name: 'Release Orbit' }],
    items: releases.map((release) => ({
      id: TAG_PREFIX + encodeURIComponent(release.id),
      url: entryLink(release),
      title: release.title || summaryOf(release),
      content_text: summaryOf(release),
      date_published: iso(release.date),
      tags: [release.family, release.stage].filter((tag) => typeof tag === 'string' && tag !== ''),
    })),
  };
  return { type: JSON_FEED_TYPE, body: JSON.stringify(feed) };
}
