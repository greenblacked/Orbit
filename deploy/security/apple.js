// The Apple security-notes adapter: the "Apple security releases" index and the security
// content page behind each row of it.
//
// An adapter is { id, vendor, index, hosts, parseIndex, parseNote, match }. All of it is pure:
// the snapshot script does the fetching (deploy/snapshot_security.mjs), and nothing here runs
// in the Worker. Only facts are kept (ids, titles, dates, URLs): never a vendor's impact or
// description text (ADR 0008). The markup was recorded by the source probe and is committed
// under tests/fixtures/apple-security/.

import { familyIds } from '../families.js';

export const ID = 'apple-security-releases';
export const VENDOR = 'apple';
export const INDEX_URL = 'https://support.apple.com/en-us/100100';
export const HOSTS = ['support.apple.com'];
export const FAMILIES = familyIds(VENDOR);

// The release feed and the index can date one release days apart (iPadOS 26.7 is dated
// 2026-09-09 in the feed and 14 Sep 2026 in the index). The version decides the match; the date
// only picks between rows of one version (the nearest wins) and refuses one 7 or more days away
// (UTC calendar dates, so the time of day never matters).
export const DATE_SLACK_DAYS = 7;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NO_CVE_TEXT = 'This update has no published CVE entries.';
const TITLE_PREFIX = 'About the security content of ';
const DAY_MS = 86400000;

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode the character references the pages use; an unknown or invalid one stays as written. */
export function decode(text) {
  const reference = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,6}));/g;
  return String(text).replace(reference, (all, dec, hex, name) => {
    if (name !== undefined) return NAMED[name.toLowerCase()] ?? all;
    const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return all;
    return code === 0xa0 ? ' ' : String.fromCodePoint(code);
  });
}

// Tags replaced by a space, found with indexOf so a page with many stray `<` stays linear.
function stripTags(text) {
  let out = '';
  let at = 0;
  for (;;) {
    const open = text.indexOf('<', at);
    const close = open < 0 ? -1 : text.indexOf('>', open);
    if (close < 0) return out + text.slice(at);
    out += `${text.slice(at, open)} `;
    at = close + 1;
  }
}

/** The text of a markup fragment: tags dropped, references decoded, spaces collapsed. */
export function textOf(fragment) {
  return decode(stripTags(String(fragment)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** `https://support.apple.com/en-us/<digits>` only: no port, credentials, query or fragment. */
export function isNoteUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      HOSTS.includes(url.hostname) &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      /^\/en-us\/\d+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/** "28 Sep 2026" as "2026-09-28"; null for anything else, including a day that does not exist. */
export function parseRowDate(text) {
  const m = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec(text);
  const month = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  if (month < 0) return null;
  const stamp = Date.UTC(Number(m[3]), month, Number(m[1]));
  const day = new Date(stamp);
  if (day.getUTCMonth() !== month || day.getUTCDate() !== Number(m[1])) return null;
  return day.toISOString().slice(0, 10);
}

/** "September 28, 2026" as "2026-09-28"; null for anything else. */
export function parseLongDate(text) {
  const m = /^([A-Za-z]{3,9}) (\d{1,2}), (\d{4})$/.exec(text);
  const month = m ? MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) : -1;
  if (month < 0) return null;
  const day = new Date(Date.UTC(Number(m[3]), month, Number(m[2])));
  if (day.getUTCMonth() !== month || day.getUTCDate() !== Number(m[2])) return null;
  return day.toISOString().slice(0, 10);
}

const PRODUCT_RE = new RegExp(
  `^(${FAMILIES.join('|')})\\s+(?:([A-Za-z][A-Za-z ]*?)\\s+)?(\\d+(?:\\.\\d+)*)$`,
);

/**
 * The products of a name such as "iOS 26.7.1 and iPadOS 26.7.1" or "macOS Tahoe 26.7.1", as
 * [{ family, version }]. Only the six families are kept (Safari, Xcode and firmware are not). A
 * macOS code name is dropped: the version number identifies the release, never the name.
 */
export function parseProducts(name) {
  const products = [];
  for (const part of String(name).split(/\s+and\s+/)) {
    const m = PRODUCT_RE.exec(part.trim());
    if (!m) continue;
    if (m[2] !== undefined && m[1] !== 'macOS') continue;
    products.push({ family: m[1], version: m[3] });
  }
  return products;
}

// The cells of one row, as markup fragments; null unless the row has three data cells.
function cellsOf(row) {
  const cells = [];
  let at = 0;
  for (;;) {
    const open = row.indexOf('<td', at);
    if (open < 0) break;
    const start = row.indexOf('>', open);
    const close = start < 0 ? -1 : row.indexOf('</td>', start);
    if (close < 0) return null;
    cells.push(row.slice(start + 1, close));
    at = close + 5;
  }
  return cells.length === 3 ? cells : null;
}

// The first paragraph of a cell: the name, without the note block that may follow it.
function firstParagraph(cell) {
  const open = cell.indexOf('<p');
  const start = open < 0 ? -1 : cell.indexOf('>', open);
  const close = start < 0 ? -1 : cell.indexOf('</p>', start);
  return close < 0 ? null : cell.slice(start + 1, close);
}

/**
 * The rows of the "Apple security releases" table as
 * [{ name, products, note, noCveEntries, date }], newest first as on the page. A row that is not
 * closed (the table was cut), has no recognised product, no valid date or no usable note is
 * dropped. A relative link is resolved against the index URL. `note` is the https URL of the
 * row's security page on support.apple.com, or null for a row that says it has no CVE entries
 * and links nowhere.
 */
export function parseIndex(html) {
  const text = String(html);
  const rows = [];
  let at = 0;
  for (;;) {
    const open = text.indexOf('<tr', at);
    if (open < 0) break;
    const close = text.indexOf('</tr>', open);
    if (close < 0) break;
    at = close + 5;
    const cells = cellsOf(text.slice(open, close));
    if (!cells) continue;
    const paragraph = firstParagraph(cells[0]);
    if (paragraph === null) continue;
    const name = textOf(paragraph);
    const products = parseProducts(name);
    const date = parseRowDate(textOf(cells[2]));
    if (products.length === 0 || date === null) continue;
    const href = /<a\s[^>]*?href="([^"]*)"/.exec(paragraph);
    const noCveEntries = textOf(cells[0]).includes(NO_CVE_TEXT);
    let note = null;
    if (href) {
      try {
        note = new URL(decode(href[1]), INDEX_URL).href;
      } catch {
        continue;
      }
      if (!isNoteUrl(note)) continue;
    } else if (!noCveEntries) {
      continue;
    }
    rows.push({ name, products, note, noCveEntries, date });
  }
  return rows;
}

const CVE_ID = /CVE-\d{4}-\d{4,}/g;
// The text before the first colon of a credit paragraph: nothing but ids and their separators.
const CVE_HEAD = /^(?:CVE-\d{4}-\d{4,}(?:\s*(?:,|and|&)\s*)?)+$/;

/** The Published Date of a note page ("September 28, 2026" as "2026-09-28"), or null. */
export function parsePublished(html) {
  const m = /Published Date:<\/span>(?:&nbsp;|\s)*<time\b[^>]*>([^<]*)<\/time>/.exec(String(html));
  return m ? parseLongDate(textOf(m[1])) : null;
}

/** The sorted, unique CVE ids that start a paragraph ("CVE-2026-86950: credit"), heading or not. */
export function cveParagraphIds(html) {
  const text = String(html);
  const ids = new Set();
  const paragraphs = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
  for (let m = paragraphs.exec(text); m !== null; m = paragraphs.exec(text)) {
    const line = textOf(m[1]);
    const head = line.split(':')[0].trim();
    if (CVE_HEAD.test(head)) for (const id of head.match(CVE_ID)) ids.add(id);
  }
  return [...ids].sort();
}

// Lowercases ASCII letters only, so every index still points into the original string
// (toLowerCase() changes the length of e.g. a dotted capital I).
const asciiLower = (text) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

// The end of the `</name  >` closing tag that starts at or after `from`, or -1. indexOf only.
function closeTagEnd(lower, name, from) {
  const needle = `</${name}`;
  for (let at = lower.indexOf(needle, from); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
    let i = at + needle.length;
    while (i < lower.length && isSpace(lower[i])) i++;
    if (lower[i] === '>') return i + 1;
  }
  return -1;
}

// Openers of what a reader never sees. An element opener needs the name followed by whitespace,
// ">" or "/" ("<styles" is not "<style"); a comment opener needs nothing more.
const HIDDEN = [
  { open: '<!--', name: null },
  { open: '<script', name: 'script' },
  { open: '<style', name: 'style' },
  { open: '<noscript', name: 'noscript' },
];

// The page text a reader sees: no script, style, noscript or comment content, no tags. One
// left-to-right pass, as a browser parses it: whatever opens first decides what is skipped, so a
// "<!--" inside a script, or a "<script" inside a comment, hides nothing else. An unclosed
// comment or element drops the rest of the page.
function visibleText(html) {
  const text = String(html);
  const lower = asciiLower(text);
  // Next opener index at or after the cursor per kind: -2 not looked up yet, -1 none left.
  const next = HIDDEN.map(() => -2);
  const opens = ({ open, name }, at) => {
    if (name === null) return true;
    const c = lower[at + open.length];
    return c === '>' || c === '/' || (c !== undefined && isSpace(c));
  };
  let out = '';
  let cursor = 0;
  for (;;) {
    let kind = -1;
    for (let k = 0; k < HIDDEN.length; k++) {
      if (next[k] === -1) continue;
      if (next[k] < cursor) {
        const { open } = HIDDEN[k];
        let at = lower.indexOf(open, cursor);
        while (at >= 0 && !opens(HIDDEN[k], at)) at = lower.indexOf(open, at + open.length);
        next[k] = at;
        if (at < 0) continue;
      }
      if (kind < 0 || next[k] < next[kind]) kind = k;
    }
    if (kind < 0) return textOf(out + text.slice(cursor));
    const start = next[kind];
    const { open, name } = HIDDEN[kind];
    out += text.slice(cursor, start);
    const end =
      name === null
        ? lower.indexOf('-->', start + open.length)
        : closeTagEnd(lower, name, start + open.length);
    if (end < 0) return textOf(out);
    cursor = name === null ? end + 3 : end;
  }
}

// At most this many h1 elements are looked at, so a hostile page cannot make the heading lookup long.
const MAX_H1 = 20;

/**
 * The page heading, as { text, h1Count, prefixInH1, prefixInTitle } with `text` null when the page has no
 * `h1` and no usable `<title>`. Lookup order: the first of the first MAX_H1 `h1` elements whose
 * visible text starts with TITLE_PREFIX; else the document `<title>` when it starts with the prefix
 * and names at least one recognised product (a trailing " - <site>" is cut off when what remains
 * still names one); else the first `h1`. `text` is the chosen heading, prefix included.
 */
function findHeading(text) {
  const re = /<h1\b[^>]*>([\s\S]*?)<\/h1>/g;
  const h1s = [];
  while (h1s.length < MAX_H1) {
    const m = re.exec(text);
    if (!m) break;
    h1s.push(textOf(m[1]));
  }
  const prefixed = h1s.find((h) => h.startsWith(TITLE_PREFIX));
  const tag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  const full = tag ? textOf(tag[1]) : '';
  const prefixInTitle = full.startsWith(TITLE_PREFIX);
  let fromTitle = null;
  if (prefixInTitle) {
    const cut = full.lastIndexOf(' - ');
    const named = (heading) => parseProducts(heading.slice(TITLE_PREFIX.length)).length > 0;
    if (cut > TITLE_PREFIX.length && named(full.slice(0, cut))) fromTitle = full.slice(0, cut);
    else if (named(full)) fromTitle = full;
  }
  const chosen = prefixed ?? fromTitle ?? h1s[0];
  return {
    text: chosen ?? null,
    h1Count: h1s.length,
    prefixInH1: prefixed !== undefined,
    prefixInTitle,
  };
}

/**
 * One security content page as { title, products, released, cves }, or null when it has no `h1`
 * and no usable `<title>` (see findHeading for the lookup order).
 * `title` is the page heading without "About the security content of". `released` is the
 * "Released ..." line, else the Published Date, else null. `cves` is the sorted, unique ids that
 * start a paragraph ("CVE-2026-86950: credit"), and nothing else of the page is kept.
 */
export function parseNote(html) {
  const text = String(html);
  const heading = findHeading(text);
  if (heading.text === null) return null;
  let title = heading.text;
  if (title.startsWith(TITLE_PREFIX)) title = title.slice(TITLE_PREFIX.length);
  const released = /<p\b[^>]*>\s*Released ([A-Za-z]{3,9} \d{1,2}, \d{4})\s*<\/p>/.exec(text);
  return {
    title,
    products: parseProducts(title),
    released: (released && parseLongDate(released[1])) ?? parsePublished(text),
    cves: cveParagraphIds(text),
  };
}

// "27.0" and "27" are one release; "27.0.1" is another.
export const normalise = (version) => String(version).replace(/(\.0)+$/, '');

const dayOf = (iso) => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);

/**
 * True when a parsed note page names the release's own product and version. A page whose heading
 * names no recognised product is refused: it is not the release's security content.
 */
export function covers(page, release) {
  const version = normalise(release.version);
  return (
    Array.isArray(page?.products) &&
    page.products.some((p) => p.family === release.family && normalise(p.version) === version)
  );
}

/**
 * Why a fetched note page is not accepted for `release`, as a short line made of fixed labels,
 * yes/no and integers only, never any text of the page (no title, product name or URL); null when
 * the page is accepted. The rule is the build's own: it parses, has 1 to `maxCves` leading CVE
 * paragraphs, and covers the release. "CVE ids anywhere in text" counts the distinct ids in the
 * visible text whether or not they start a paragraph, so a layout change (ids moved into a table
 * or list) reads as paragraphs 0 and ids anywhere above 0. For the snapshot's report.
 */
export function whyNotUsable(html, release, maxCves) {
  const text = String(html);
  const page = parseNote(text);
  const count = cveParagraphIds(text).length;
  if (page && count > 0 && count <= maxCves && covers(page, release)) return null;
  const yn = (value) => (value ? 'yes' : 'no');
  const heading = findHeading(text);
  const anywhere = new Set(visibleText(text).match(CVE_ID) ?? []).size;
  return (
    `h1: ${yn(heading.h1Count)}; title prefix: ${yn(heading.text?.startsWith(TITLE_PREFIX))}; ` +
    `h1 count: ${heading.h1Count}; prefix in any h1: ${yn(heading.prefixInH1)}; ` +
    `prefix in title: ${yn(heading.prefixInTitle)}; ` +
    `products recognised: ${page ? page.products.length : 0}; ` +
    `covers release: ${yn(page && covers(page, release))}; CVE paragraphs: ${count}; ` +
    `CVE ids anywhere in text: ${anywhere}; over CVE cap: ${yn(count > maxCves)}; ` +
    `bytes: ${new TextEncoder().encode(text).length}`
  );
}

/**
 * What to do for each release of this vendor, as [{ id, status, row }]. A build that is not a
 * `release` is `not-applicable` (vendors publish security pages only for released builds). A
 * release is `matched` to the row with its family and version number, dated less than 7 days (`DATE_SLACK_DAYS`, UTC dates) from
 * it, and `not-found` when none is. If two rows fit, the nearer date wins, then the first.
 */
export function match(releases, rows) {
  const found = [];
  for (const release of releases) {
    if (release.vendor !== VENDOR) continue;
    if (release.stage !== 'release') {
      found.push({ id: release.id, status: 'not-applicable', row: null });
      continue;
    }
    const day = dayOf(release.date);
    let best = null;
    let bestGap = Infinity;
    for (const row of rows) {
      const fits = row.products.some(
        (p) => p.family === release.family && normalise(p.version) === normalise(release.version),
      );
      const gap = Math.abs(dayOf(row.date) - day) / DAY_MS;
      if (fits && gap < DATE_SLACK_DAYS && gap < bestGap) {
        best = row;
        bestGap = gap;
      }
    }
    found.push(
      best
        ? { id: release.id, status: 'matched', row: best }
        : { id: release.id, status: 'not-found', row: null },
    );
  }
  return found;
}

export default {
  id: ID,
  vendor: VENDOR,
  index: INDEX_URL,
  hosts: HOSTS,
  parseIndex,
  parseNote,
  match,
  covers,
  whyNotUsable,
};
