// The Android adapter: the AOSP "Codenames, tags, and build numbers" page, an HTML document
// whose second table lists every release tag with its build id.
//
// An adapter is { id, vendor, urls, parse }. `urls` is the allowlist: the Worker fetches
// these URLs and no others. `parse(text)` turns one fetched document into releases of the
// contract in ../releases.js, newest first. It does no I/O.
//
// What it reads (verified by a read-only probe on 2026-10-12, see docs/adr/0006): the table
// whose header cells are "Build ID", "Tag", "Version", "Supported devices" and "Security
// patch level". One release per row whose tag is android-<major>.<minor>.<patch>_r<N>, for
// example android-17.0.0_r1 with build CP2A.260605.016. Rows tagged android-security-* carry
// a bare numeric build id and are security-only refreshes; the release contract has no stage
// for them, so they are skipped. Every row is a final AOSP release: the page lists no
// pre-release, so `stage` is always "release". No text of the page is kept apart from the
// tag and the build id.
//
// Bounds on what is emitted (ADR 0006): only rows dated within WINDOW_DAYS (180, a little
// under the dial's 26 weeks) of the newest row are kept, so the live page's history back to
// 2009 does not widen the dial to 52 weeks or fill the timeline with old device builds. A row
// dated more than a day after the clock is refused (a typo such as CP2A.990605.016 must not
// pin a release in 2099). Within one day the revision number orders the releases: the time of
// day is the revision in seconds (android-15.0.0_r36 is 00:00:36), so r36 sorts before r31.

import { familyIds } from '../families.js';
import { mergeReleases } from '../releases.js';

export const ID = 'android-build-numbers';
export const VENDOR = 'google';
export const HOST = 'source.android.com';
export const PAGE_URL = 'https://source.android.com/docs/setup/reference/build-numbers';
export const FAMILIES = familyIds(VENDOR);

const FAMILY = 'Android';

// Bounds on what the scanner will look at, whatever the document claims.
export const MAX_INPUT = 2 * 1024 * 1024;
export const MAX_TABLES = 50;
export const MAX_ROWS = 5000;
export const MAX_CELLS = 16;
const MAX_CELL_TEXT = 200;
export const WINDOW_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
// Elements whose content is text, not markup: the scanner jumps to their closing tag.
const RAW_TEXT = new Set(['script', 'style', 'template', 'textarea']);

const TAG_RE = /^android-(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})_r(0|[1-9]\d{0,2})$/;
// CP2A.260605.016, BP2A.250605.031.A3, OPM1.171019.011; a bare number is a security refresh.
const BUILD_RE = /^(?:[A-Z][A-Z0-9]{3,4}\.\d{6}\.\d{3}(?:\.[A-Z0-9]{1,4})?|\d{6,10})$/;
const PATCH_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BUILD_DATE_RE = /^[A-Z][A-Z0-9]{3,4}\.(\d{2})(\d{2})(\d{2})\./;
const HEADERS = ['build id', 'tag', 'security patch level'];

// A tag's name with ASCII letters lower-cased, which keeps every index of the original.
const lower = (text) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

function cellText(raw) {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CELL_TEXT);
}

/**
 * The tables of an HTML document as rows of cell texts (<th> and <td> alike, tags inside a
 * cell removed, entities left as written). A small strict scanner: it walks the tags once,
 * looks at no more than MAX_INPUT characters, keeps MAX_TABLES tables, MAX_ROWS rows per
 * table and MAX_CELLS cells per row, ignores nested tables, comments and the content of
 * script, style, template and textarea elements, and drops a table
 * that is never closed. It builds no DOM and evaluates nothing.
 */
export function tables(html) {
  const text = String(html ?? '').slice(0, MAX_INPUT);
  const folded = lower(text);
  const found = [];
  let depth = 0;
  let rows = null;
  let row = null;
  let cellStart = -1;

  const endCell = (at) => {
    if (cellStart >= 0 && row && row.length < MAX_CELLS) {
      row.push(cellText(text.slice(cellStart, at)));
    }
    cellStart = -1;
  };
  const endRow = (at) => {
    endCell(at);
    if (row && rows.length < MAX_ROWS) rows.push(row);
    row = null;
  };

  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('<', at);
    if (open < 0) break;
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      if (end < 0) break;
      at = end + 3;
      continue;
    }
    const close = text.indexOf('>', open + 1);
    if (close < 0) break;
    at = close + 1;
    const tag = /^<(\/?)([A-Za-z][A-Za-z0-9]*)(?=[\s/>])/.exec(text.slice(open, open + 16));
    if (!tag) continue;
    const closing = tag[1] === '/';
    const name = tag[2].toLowerCase();
    if (!closing && RAW_TEXT.has(name)) {
      const end = folded.indexOf(`</${name}`, at);
      if (end < 0) break;
      at = end;
      continue;
    }
    if (name === 'table') {
      if (!closing) {
        depth += 1;
        if (depth === 1) rows = [];
      } else if (depth > 0) {
        depth -= 1;
        if (depth === 0) {
          endRow(open);
          if (found.length < MAX_TABLES) found.push(rows);
          rows = null;
        }
      }
    } else if (depth === 1) {
      if (name === 'tr') {
        endRow(open);
        if (!closing) row = [];
      } else if (name === 'td' || name === 'th') {
        endCell(open);
        if (!closing && row) cellStart = close + 1;
      }
    }
  }
  return found;
}

/** The rows of the build table and the columns that matter; null when it is not there. */
export function buildTable(html) {
  for (const rows of tables(html)) {
    if (rows.length === 0) continue;
    const header = rows[0].map(lower);
    const columns = HEADERS.map((name) => header.indexOf(name));
    if (columns.every((index) => index >= 0)) {
      const [build, tag, patch] = columns;
      return { rows: rows.slice(1), build, tag, patch };
    }
  }
  return null;
}

function isoDay(year, month, day, now) {
  if (year < 2008 || year > 2099) return null;
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return null;
  }
  // A day more than a day ahead of the clock is a typo on the page, not a release.
  if (at.getTime() > now + DAY_MS) return null;
  return at.toISOString().replace('.000Z', 'Z');
}

/** The day a build was cut: its YYMMDD segment, else the security patch level; null if neither. */
export function buildDate(build, patchLevel, now = Date.now()) {
  const fromBuild = BUILD_DATE_RE.exec(build);
  if (fromBuild) {
    const date = isoDay(2000 + Number(fromBuild[1]), Number(fromBuild[2]), Number(fromBuild[3]), now);
    if (date) return date;
  }
  const fromPatch = PATCH_RE.exec(patchLevel);
  if (!fromPatch) return null;
  return isoDay(Number(fromPatch[1]), Number(fromPatch[2]), Number(fromPatch[3]), now);
}

/** One table row as a release; null for a security refresh, a pre-release tag or a bad row. */
export function parseRow(cells, columns, now = Date.now()) {
  const tag = cells[columns.tag];
  const build = cells[columns.build];
  const patchLevel = cells[columns.patch];
  if (typeof tag !== 'string' || typeof build !== 'string' || typeof patchLevel !== 'string') {
    return null;
  }
  const m = TAG_RE.exec(tag);
  if (!m || !BUILD_RE.test(build)) return null;
  const day = buildDate(build, patchLevel, now);
  if (!day) return null;
  // The revision number is the time of day in seconds (at most 999), so within one day the
  // higher revision is the newer release.
  const seconds = Number(m[4]);
  const date = day.replace(
    'T00:00:00Z',
    `T00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}Z`,
  );
  return {
    id: tag,
    vendor: VENDOR,
    family: FAMILY,
    version: `${m[1]}.${m[2]}.${m[3]}`,
    major: Number(m[1]),
    stage: 'release',
    beta: null,
    build,
    title: `Android ${m[1]} (${tag})`,
    date,
    url: PAGE_URL,
    source: ID,
  };
}

/**
 * Releases of the Android family in the build-numbers page, newest first, within `windowDays`
 * of the newest one. `now` and `windowDays` are for tests; the Worker passes neither.
 */
export function parsePage(html, now = Date.now(), windowDays = WINDOW_DAYS) {
  if (!FAMILIES.includes(FAMILY)) return [];
  const table = buildTable(html);
  if (!table) return [];
  const releases = [];
  for (const cells of table.rows) {
    const release = parseRow(cells, table, now);
    if (release) releases.push(release);
  }
  const sorted = mergeReleases([], releases);
  if (sorted.length === 0) return sorted;
  // Keep what is within the window of the newest row; the page reaches back to 2009.
  const floor = Date.parse(sorted[0].date) - windowDays * DAY_MS;
  return sorted.filter((release) => Date.parse(release.date) >= floor);
}

// An HTML page: ask for it as one.
export const ACCEPT = 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1';

export default {
  id: ID,
  vendor: VENDOR,
  accept: ACCEPT,
  urls: [PAGE_URL],
  parse: parsePage,
};
