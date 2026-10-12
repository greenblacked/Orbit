// The Microsoft adapter: Windows release health on Microsoft Learn, two HTML pages whose
// first table lists the versions Microsoft still services (Windows 11 and Windows 10).
//
// It follows apple.js: { id, vendor, urls, parse }. `urls` is the allowlist, and `parse(text)`
// turns one fetched page into releases of the contract in ../releases.js, with no I/O. The
// pages are HTML, and a Worker has no DOM, so a small strict scanner reads the first table
// by its header names: a page whose table is not the one expected yields nothing, and a row
// that is not exactly the expected shape is skipped. Only the version, build, date, update
// label and link are kept, never page text.

import { familyIds } from '../families.js';
import { isHttpsOn, mergeReleases } from '../releases.js';

export const ID = 'microsoft-windows-release-health';
export const VENDOR = 'microsoft';
export const HOST = 'learn.microsoft.com';
export const KB_HOST = 'support.microsoft.com';
export const WINDOWS_11_URL =
  'https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information';
export const WINDOWS_10_URL =
  'https://learn.microsoft.com/en-us/windows/release-health/release-information';
export const FAMILIES = familyIds(VENDOR);

const PAGES = { 11: WINDOWS_11_URL, 10: WINDOWS_10_URL };
const SERVICING = 'General Availability Channel';

// Bounds on what is read, so a hostile or runaway page costs a fixed amount of work.
const MAX_HTML = 2 * 1024 * 1024;
const MAX_ROWS = 64;
const MAX_CELLS = 16;
const MAX_CELL = 4000;

const VERSION_RE = /^(\d{2})H[12]$/;
const BUILD_RE = /^\d{5}\.\d{1,5}$/;
const UPDATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])(?: [A-Za-z]{1,5})?$/;
const KB_PATH_RE = /^\/help\/\d{6,8}$/;

/** ISO day "2026-09-29" to "2026-09-29T00:00:00Z"; null for anything else, impossible days too. */
export function parseIsoDay(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? ''));
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date.toISOString().replace('.000Z', 'Z');
}

/** The KB link as https://support.microsoft.com/help/<digits>, or null when it is anything else. */
export function kbUrl(href) {
  if (!isHttpsOn(href, KB_HOST)) return null;
  const url = new URL(href);
  if (url.username || url.password || url.port || !KB_PATH_RE.test(url.pathname)) return null;
  return `https://${KB_HOST}${url.pathname}`;
}

/** 11 or 10 from the page title "Windows 11 - release information | ..."; null otherwise. */
export function productOf(html) {
  const m = /<title[^>]*>\s*Windows (10|11) - release information\b/i.exec(
    String(html ?? '').slice(0, MAX_HTML),
  );
  return m ? m[1] : null;
}

/** The inner HTML of the first table in a document, or null when there is none. */
export function firstTable(html) {
  const text = String(html ?? '').slice(0, MAX_HTML);
  const open = /<table\b[^>]*>/i.exec(text);
  if (!open) return null;
  const rest = text.slice(open.index + open[0].length);
  const close = /<\/table\s*>/i.exec(rest);
  return close ? rest.slice(0, close.index) : null;
}

function cellText(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The rows of a table as arrays of { header, text, href }; bounded in rows, cells and size. */
export function tableRows(tableHtml) {
  const rows = [];
  for (const row of String(tableHtml ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    if (rows.length >= MAX_ROWS) break;
    const cells = [];
    for (const cell of row[1].matchAll(/<(t[dh])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
      if (cells.length >= MAX_CELLS) break;
      const inner = cell[2];
      const link = inner.length > MAX_CELL ? null : /<a\b[^>]*?\shref\s*=\s*"([^"]*)"/i.exec(inner);
      cells.push({
        header: cell[1].toLowerCase() === 'th',
        text: inner.length > MAX_CELL ? '' : cellText(inner),
        href: link ? link[1] : null,
      });
    }
    rows.push(cells);
  }
  return rows;
}

// Column positions from the header row, or null when the table is not the one expected. The
// "End of updates" columns tell the servicing table from the LTSC table that follows it.
function columns(header) {
  if (header.length === 0 || !header.every((cell) => cell.header)) return null;
  const names = header.map((cell) => cell.text.toLowerCase());
  const cols = {
    version: names.indexOf('version'),
    servicing: names.indexOf('servicing option'),
    available: names.indexOf('availability date'),
    update: names.findIndex((name) => name.startsWith('latest update')),
    revised: names.indexOf('latest revision date'),
    build: names.indexOf('latest build'),
    ends: names.flatMap((name, i) => (name.startsWith('end of updates') ? [i] : [])),
  };
  const { ends, ...single } = cols;
  return ends.length > 0 && Object.values(single).every((i) => i >= 0) ? cols : null;
}

/** Releases in one release-information page (Windows 11 or 10), newest first. */
export function parsePage(html) {
  const text = String(html ?? '').slice(0, MAX_HTML);
  const product = productOf(text);
  const table = firstTable(text);
  if (!product || !table) return [];
  const family =
    FAMILIES.find((name) => name === `Windows ${product}`) ?? FAMILIES.find((name) => name === 'Windows');
  if (!family) return [];
  const rows = tableRows(table);
  const cols = rows.length > 1 ? columns(rows[0]) : null;
  if (!cols) return [];
  const page = PAGES[product];
  const releases = [];
  for (const row of rows.slice(1)) {
    if (row.length !== rows[0].length || row.some((cell) => cell.header)) continue;
    if (row[cols.servicing].text !== SERVICING) continue;
    const version = VERSION_RE.exec(row[cols.version].text);
    const build = row[cols.build].text;
    const date = parseIsoDay(row[cols.revised].text);
    if (!version || !BUILD_RE.test(build) || !date) continue;
    // The contract has no end-of-support field, so a version Microsoft has stopped
    // updating for every edition says so in its title.
    const ended = cols.ends.every((i) => row[i].text.toLowerCase() === 'end of updates');
    const label = UPDATE_RE.test(row[cols.update].text) ? row[cols.update].text : '';
    const notes = [label, ended ? 'end of updates' : ''].filter(Boolean);
    releases.push({
      id: `${page}#${version[0].toLowerCase()}-${build}`,
      vendor: VENDOR,
      family,
      version: version[0],
      major: Number(version[1]),
      stage: 'release',
      beta: null,
      build,
      title: `Windows ${product} ${version[0]}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`,
      date,
      url: kbUrl(row[cols.update].href) ?? page,
      source: ID,
    });
  }
  return mergeReleases([], releases);
}

export default {
  id: ID,
  vendor: VENDOR,
  urls: [WINDOWS_11_URL, WINDOWS_10_URL],
  parse: parsePage,
};
