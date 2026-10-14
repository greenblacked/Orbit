// The Android security adapter: the Android Security Bulletins (AOSP) read into the security
// payload of ADR 0008. It runs in the snapshot step, never in the Worker, and does no I/O.
//
// What it reads (recorded by a read-only probe on 2026-10-12, fixtures under
// tests/fixtures/android-security/):
// - A bulletin page has `<em>Published October 5, 2026 | Updated October 8, 2026</em>` (the
//   Pixel bulletin has no Updated part), one sentence that names the security patch level
//   ("Security patch levels of 2026-10-01 or higher address all of these issues", wrapped
//   across lines), and several tables. The CVE tables have a header whose first cell is CVE
//   and which has a Severity column (AOSP: CVE, References, Type, Severity, Updated AOSP
//   versions; Pixel: the last is Subcomponent). The Subcomponent/CVE table, the Abbreviation,
//   Prefix and Version history tables are not CVE tables and are ignored.
// - The patch level of a release is the "Security patch level" cell of its row in the AOSP
//   build-numbers page (see ../sources/android.js), used as the exact string. It is never
//   derived from the release date: android-15.0.0_r25 is dated 2025-04-05 by its build id and
//   has the patch level 2025-02-05.
//
// Only CVE ids, the page title, dates, the bulletin URL and the vendor's severity label are
// kept (ADR 0008 rule 5). The Pixel bulletin is read by the same parser but is a separate
// source and is never joined to an Android release: its patch level is a device level, and
// the ADR defines no rule for it.

import { buildTable, PAGE_URL, tables } from '../sources/android.js';
import { decode } from './apple.js';

export const SOURCE_ID = 'android-security-bulletin';
export const PIXEL_SOURCE_ID = 'android-pixel-bulletin';
export const HOST = 'source.android.com';
export const BASE = `https://${HOST}/docs/security/bulletin`;
export const FAMILY = 'Android';

// Bounds on what the scanners look at, whatever the document claims.
export const MAX_INPUT = 2 * 1024 * 1024;
export const MAX_CVES = 2000;
export const MAX_PATCH_LEVELS = 4;
export const MAX_PATCH_TAGS = 5000;
// Months of bulletins a snapshot asks for (Android's own are about 135 since 2015-08).
export const MAX_BULLETINS = 200;
const MAX_TITLE = 200;
const MAX_SEVERITY = 40;

const CVE_RE = /^CVE-\d{4}-\d{4,}$/;
const PATCH_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SEVERITY_RE = /^[A-Za-z][A-Za-z /-]*$/;
const PATCH_SENTENCE_RE =
  /security patch levels?\s+of\s+(\d{4}-\d{2}-\d{2})\s+or\s+(?:higher|later)/gi;
// The only wording read as "this bulletin lists nothing". Not seen on a recorded page: an empty
// bulletin has not been probed, so this is a guess that fails safe (no match gives unavailable).
const NO_PATCHES_RE = /\bno\s+security\s+(?:patches|fixes|vulnerabilities)\b/i;
const TITLE_RE = /^Android Security Bulletin/;
const DATE_RE = /\b(Published|Updated)\s+([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})\b/g;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
// The same order the payload contract checks with `<` (not a numeric order).
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RAW_TEXT = new Set(['script', 'style', 'template', 'textarea']);

/** A real calendar day as YYYY-MM-DD, else null. */
function isoDay(year, month, day) {
  const at = new Date(Date.UTC(year, month - 1, day));
  if (year < 2008 || year > 2099) return null;
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return null;
  }
  return at.toISOString().slice(0, 10);
}

/** A patch level as written (YYYY-MM-DD) when it is a real day, else null. */
export function validPatchLevel(value) {
  const m = typeof value === 'string' ? PATCH_RE.exec(value) : null;
  return m ? isoDay(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

/** The visible text of a document: tags, comments and raw-text elements removed. Linear. */
function visibleText(html) {
  const text = String(html ?? '').slice(0, MAX_INPUT);
  const folded = text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const out = [];
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('<', at);
    if (open < 0) {
      out.push(text.slice(at));
      break;
    }
    out.push(text.slice(at, open), ' ');
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      if (end < 0) break;
      at = end + 3;
      continue;
    }
    const close = text.indexOf('>', open + 1);
    if (close < 0) break;
    at = close + 1;
    const tag = /^<([A-Za-z][A-Za-z0-9]*)(?=[\s/>])/.exec(folded.slice(open, open + 16));
    if (tag && RAW_TEXT.has(tag[1])) {
      const end = folded.indexOf(`</${tag[1]}`, at);
      if (end < 0) break;
      at = end;
    }
  }
  return out.join('').replace(/\s+/g, ' ');
}

/** The title element without the site suffix ("... | Android Open Source Project"). */
function titleOf(html) {
  const text = String(html ?? '').slice(0, MAX_INPUT);
  const folded = text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const open = folded.indexOf('<title');
  if (open < 0) return null;
  const start = folded.indexOf('>', open);
  const end = start < 0 ? -1 : folded.indexOf('</title', start);
  if (end < 0) return null;
  // The live page writes the separator as `&nbsp;|&nbsp;`: decode first, then split.
  const title = decode(text.slice(start + 1, Math.min(end, start + 1 + MAX_TITLE)))
    .replace(/\s+/g, ' ')
    .split(/\s*\|\s*/)[0]
    .trim();
  return title === '' ? null : title;
}

/** `Published October 5, 2026` and `Updated October 8, 2026` as dates; null when absent. */
function datesOf(text) {
  const found = { Published: null, Updated: null };
  for (const m of text.matchAll(DATE_RE)) {
    const month = MONTHS.indexOf(m[2]) + 1;
    const day = month > 0 ? isoDay(Number(m[4]), month, Number(m[3])) : null;
    if (day && found[m[1]] === null) found[m[1]] = day;
  }
  return { published: found.Published, updated: found.Updated };
}

/** The sorted, unique patch levels named by the "security patch levels of ..." sentences. */
function patchLevelsOf(text) {
  const levels = new Set();
  for (const m of text.matchAll(PATCH_SENTENCE_RE)) {
    const level = validPatchLevel(m[1]);
    if (level) levels.add(level);
    if (levels.size >= MAX_PATCH_LEVELS) break;
  }
  return [...levels].sort(byText);
}

/**
 * The CVE rows of every table that starts with CVE and has a Severity column, and how many such
 * tables there were. At most MAX_CVES ids are kept, whatever the page holds.
 */
function cvesOf(html) {
  const found = new Map();
  let cveTables = 0;
  scan: for (const rows of tables(html)) {
    if (rows.length === 0) continue;
    const header = rows[0].map((cell) => cell.toLowerCase());
    const severity = header.indexOf('severity');
    if (header[0] !== 'cve' || severity < 0) continue;
    cveTables += 1;
    for (const cells of rows.slice(1)) {
      const id = (cells[0] ?? '').toUpperCase();
      if (!CVE_RE.test(id) || found.has(id)) continue;
      if (found.size >= MAX_CVES) break scan;
      const label = cells[severity] ?? '';
      const known = label.length <= MAX_SEVERITY && SEVERITY_RE.test(label);
      found.set(id, { id, severity: known ? label : null });
    }
  }
  return { cveTables, cves: [...found.values()].sort((a, b) => byText(a.id, b.id)) };
}

/**
 * One bulletin page as { title, published, updated, patchLevels, cveTables, noPatches, cves }.
 * Dates are YYYY-MM-DD or null. `cveTables` is how many CVE tables the page had and `noPatches`
 * whether it says outright that it has no security patches. `cves` come from the CVE tables only, with ids upper-cased, unique and
 * sorted as the payload contract sorts them, and the vendor's severity label as written (null
 * when the cell is empty or not a label). A row that is not a CVE id is skipped. It never
 * throws and keeps no description text.
 */
export function parseBulletin(html) {
  const text = visibleText(html);
  const { published, updated } = datesOf(text);
  const { cveTables, cves } = cvesOf(html);
  return {
    title: titleOf(html),
    published,
    updated,
    patchLevels: patchLevelsOf(text),
    cveTables,
    noPatches: NO_PATCHES_RE.test(text),
    cves,
  };
}

function monthParts(patchLevel) {
  const level = validPatchLevel(patchLevel);
  return level ? { year: level.slice(0, 4), month: level.slice(5, 7) } : null;
}

/**
 * The AOSP bulletin of the month of a patch level, or null for a bad level. The page for a
 * month is dated the 1st: /docs/security/bulletin/2026/2026-10-01 from 2026 on, and
 * /docs/security/bulletin/2025-12-01 before (seen in the October 2026 page's own links for
 * 2025-03 to 2025-12; earlier years are assumed to follow the older form and were not seen).
 */
export function bulletinUrl(patchLevel) {
  const parts = monthParts(patchLevel);
  if (!parts) return null;
  const name = `${parts.year}-${parts.month}-01`;
  return Number(parts.year) >= 2026 ? `${BASE}/${parts.year}/${name}` : `${BASE}/${name}`;
}

/**
 * The Pixel Update Bulletin of the month: /docs/security/bulletin/pixel/2026/2026-10-01. Only
 * the 2026 form was seen, so an earlier year gives null instead of a guess. It is a separate
 * source from the AOSP bulletin and is never joined to a release.
 */
export function pixelBulletinUrl(patchLevel) {
  const parts = monthParts(patchLevel);
  if (!parts || Number(parts.year) < 2026) return null;
  return `${BASE}/pixel/${parts.year}/${parts.year}-${parts.month}-01`;
}

/**
 * The security patch level of each release tag in the build-numbers page, as a Map from the
 * tag (the release id) to the cell's exact YYYY-MM-DD string. A row with a missing or bad
 * level, and a tag that appears twice with different levels, has no entry: the level is then
 * unknown, not guessed.
 */
export function patchLevelsByTag(html) {
  const table = buildTable(html);
  const levels = new Map();
  const conflicts = new Set();
  if (!table) return levels;
  for (const cells of table.rows.slice(0, MAX_PATCH_TAGS)) {
    const tag = cells[table.tag];
    const level = validPatchLevel(cells[table.patch]);
    if (typeof tag !== 'string' || tag === '' || !level) continue;
    if (levels.has(tag) && levels.get(tag) !== level) conflicts.add(tag);
    levels.set(tag, level);
  }
  for (const tag of conflicts) levels.delete(tag);
  return levels;
}

const isAndroid = (row) => row?.family === FAMILY && row?.vendor === 'google';

/**
 * The AOSP bulletin URLs a snapshot must read: every month from the oldest to the newest patch
 * level of the given Android releases, sorted. The months between two releases are needed too,
 * because Compare takes the bulletins in (older, newer] (ADR 0008). Capped at MAX_BULLETINS,
 * keeping the newest months.
 */
export function neededBulletins(releases, patchLevels) {
  const levels = [];
  for (const row of releases) {
    if (!isAndroid(row) || row.stage !== 'release') continue;
    const level = validPatchLevel(patchLevels.get(row.id));
    if (level) levels.push(level);
  }
  if (levels.length === 0) return [];
  levels.sort(byText);
  const oldest = levels[0];
  let year = Number(levels[levels.length - 1].slice(0, 4));
  let month = Number(levels[levels.length - 1].slice(5, 7));
  const urls = [];
  while (urls.length < MAX_BULLETINS) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    if (key < oldest.slice(0, 7)) break;
    urls.push(bulletinUrl(`${key}-01`));
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return urls.sort(byText);
}

/** The payload note of a parsed bulletin (ADR 0008 data contract). */
export function bulletinNote(bulletin, source = SOURCE_ID) {
  return {
    source,
    title: bulletin.title,
    published: bulletin.published,
    cves: bulletin.cves.map(({ id, severity }) => ({ id, severity })),
    noCveEntries: bulletin.cves.length === 0,
  };
}

// A bulletin counts as read only when the page looks like the AOSP bulletin of that month: a
// title that starts with "Android Security Bulletin" (the Pixel page is another bulletin), a
// publish date and a patch level in the month. It is then used only when it says something: CVE
// rows, or an explicit "no security patches" with no CVE table. Otherwise a changed or wrong
// page would read as a bulletin with no CVEs, and a wrong "0" is worse than saying nothing.
function isRead(bulletin, month) {
  if (!bulletin || bulletin.published === null) return false;
  if (typeof bulletin.title !== 'string' || !TITLE_RE.test(bulletin.title)) return false;
  if (!bulletin.patchLevels.some((level) => level.slice(0, 7) === month)) return false;
  if (bulletin.cves.length > 0) return true;
  return bulletin.noPatches === true && bulletin.cveTables === 0;
}

// The month ("YYYY-MM") of an AOSP bulletin URL, or null when the URL is not one we build.
function monthOfUrl(url) {
  const m = /\/(\d{4})-(\d{2})-01$/.exec(typeof url === 'string' ? url : '');
  return m && bulletinUrl(`${m[1]}-${m[2]}-01`) === url ? `${m[1]}-${m[2]}` : null;
}

function entry(status, patchLevel, checkedAt, url = null, cves = []) {
  return {
    status,
    notes: url ? [url] : [],
    cves,
    count: status === 'listed' ? cves.length : status === 'no-cve-entries' ? 0 : null,
    patchLevel,
    checkedAt,
  };
}

/**
 * Join the Android releases of `releases` (rows of releases.json) to the bulletins.
 * `patchLevels` is the Map of patchLevelsByTag; `bulletins` is a Map from an AOSP bulletin URL
 * to its parseBulletin result, holding only the pages that were read. Returns
 * { notes, releases } in the shape of the payload. `releases` has Android rows only; `notes`
 * holds every bulletin read for its own month, whether a release points at it or not:
 *
 * - not a release (beta or rc): `not-applicable`, no patch level;
 * - no patch level for the release: `not-found`, `patchLevel` null;
 * - patch level known but its bulletin not read: `unavailable`, `patchLevel` set;
 * - bulletin read with CVE rows: `listed`, the CVEs of that month's bulletin only;
 * - bulletin read, no CVE rows and the page says it has no security patches: `no-cve-entries`
 *   (count 0); no CVE rows without that statement is not a read bulletin (`unavailable`).
 *
 * Per ADR 0008 a row holds its own bulletin only, never a union over earlier months.
 */
export function match(releases, patchLevels, bulletins, checkedAt) {
  const notes = {};
  const rows = {};
  for (const row of releases) {
    if (!isAndroid(row)) continue;
    if (row.stage !== 'release') {
      rows[row.id] = entry('not-applicable', null, checkedAt);
      continue;
    }
    const patchLevel = validPatchLevel(patchLevels.get(row.id));
    if (!patchLevel) {
      rows[row.id] = entry('not-found', null, checkedAt);
      continue;
    }
    const url = bulletinUrl(patchLevel);
    const bulletin = bulletins.get(url);
    if (!isRead(bulletin, patchLevel.slice(0, 7))) {
      rows[row.id] = entry('unavailable', patchLevel, checkedAt);
      continue;
    }
    const ids = bulletin.cves.map((cve) => cve.id);
    rows[row.id] =
      ids.length > 0
        ? entry('listed', patchLevel, checkedAt, url, ids)
        : entry('no-cve-entries', patchLevel, checkedAt, url);
  }
  // A note for every bulletin read, joined to a release or not: Compare needs the months in
  // between (ADR 0008).
  for (const [url, bulletin] of [...bulletins].sort((a, b) => byText(a[0], b[0]))) {
    const month = monthOfUrl(url);
    if (month && isRead(bulletin, month)) notes[url] = bulletinNote(bulletin);
  }
  return { notes, releases: rows };
}

// The registry shape (index.js). `kind: 'bulletins'` tells the payload builder that this source
// is read differently from an index-and-notes source such as Apple: its `index` is the
// build-numbers page, which parseIndex turns into the Map of patch levels, and the pages to read
// are the bulletins neededPages names; match takes the levels and the parsed bulletins.
export default {
  id: SOURCE_ID,
  kind: 'bulletins',
  vendor: 'google',
  family: FAMILY,
  host: HOST,
  hosts: [HOST],
  // source.android.com redirects a page to a random localized variant (?hl=it); the parser reads
  // English only, so every request asks for hl=en and the snapshot refuses any other hl.
  lang: { param: 'hl', value: 'en' },
  index: PAGE_URL,
  maxPages: MAX_BULLETINS,
  parseIndex: patchLevelsByTag,
  neededPages: neededBulletins,
  parseBulletin,
  bulletinUrl,
  match,
};
