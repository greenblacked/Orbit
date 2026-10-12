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

// A release date and a row date may differ by the time zone of the clock that wrote them.
export const DATE_SLACK_DAYS = 2;

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

/** The text of a markup fragment: tags dropped, references decoded, spaces collapsed. */
export function textOf(fragment) {
  return decode(String(fragment).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** `https://support.apple.com/...` only: no other scheme, host, port or credentials. */
export function isNoteUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      HOSTS.includes(url.hostname) &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
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
 * dropped. `note` is the https URL of the row's security page on support.apple.com, or null for a
 * row that says it has no CVE entries and links nowhere.
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
      note = decode(href[1]);
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

/**
 * One security content page as { title, products, released, cves }, or null when it has no `h1`.
 * `title` is the page heading without "About the security content of". `released` is the
 * "Released ..." line, else the Published Date, else null. `cves` is the sorted, unique ids that
 * start a paragraph ("CVE-2026-86950: credit"), and nothing else of the page is kept.
 */
export function parseNote(html) {
  const text = String(html);
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(text);
  if (!h1) return null;
  let title = textOf(h1[1]);
  if (title.startsWith(TITLE_PREFIX)) title = title.slice(TITLE_PREFIX.length);
  const released = /<p\b[^>]*>\s*Released ([A-Za-z]{3,9} \d{1,2}, \d{4})\s*<\/p>/.exec(text);
  const ids = new Set();
  const paragraphs = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
  for (let m = paragraphs.exec(text); m !== null; m = paragraphs.exec(text)) {
    const line = textOf(m[1]);
    const head = line.split(':')[0].trim();
    if (CVE_HEAD.test(head)) for (const id of head.match(CVE_ID)) ids.add(id);
  }
  return {
    title,
    products: parseProducts(title),
    released: (released && parseLongDate(released[1])) ?? parsePublished(text),
    cves: [...ids].sort(),
  };
}

// "27.0" and "27" are one release; "27.0.1" is another.
const normalise = (version) => String(version).replace(/(\.0)+$/, '');

const dayOf = (iso) => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);

/**
 * What to do for each release of this vendor, as [{ id, status, row }]. A build that is not a
 * `release` is `not-applicable` (vendors publish security pages only for released builds). A
 * release is `matched` to the row with its family and version number, dated within two days of
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
      if (fits && gap <= DATE_SLACK_DAYS && gap < bestGap) {
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
};
