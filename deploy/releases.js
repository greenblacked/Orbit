// What every source adapter shares: the release contract, date parsing, light XML reading
// and the merge. Pure functions, no dependencies, no I/O: the Worker, the adapters, the
// snapshot script and the tests all import this one file, so they cannot disagree about
// what a release is.
//
// A release (the multi-vendor data contract):
//   { id, vendor, family, version, major, stage, beta, build, title, date, url, source }
// `vendor` is the maker ("apple"), `family` the platform ("iOS"), `source` the id of the
// adapter that produced it ("apple-developer-releases"). `stage` is "release", "beta" or
// "rc". `beta` is the iteration number of a beta or RC ("beta 3" and "RC 2" are 3 and 2; a
// bare "beta" or "RC" and a final release are null). `date` is ISO-8601 UTC without
// milliseconds. Only the title, build, date and link are kept, never release-notes text.
// A family with several supported lines at once adds an optional last field, `line`: the
// RouterOS channel ("stable", "long-term", "testing") or the Windows feature update ("24H2").
// A family with one line (Apple, Android, SteamOS) has no `line` key at all, never null.

// Each source keeps its newest MAX_RELEASES_PER_SOURCE releases, so a large source cannot
// push another's rows out. The largest live source is the AOSP tag page (about 300 release
// tags back to 2009, and growing), so 1000 leaves about 3 times that; the whole list is
// bounded at 1000 rows per source. The cap applies only where lists are merged (the Worker
// and the snapshot script); adapters sort without capping, so nothing is dropped quietly
// inside a parser. A source near the cap is a signal to raise it on purpose:
// tests/snapshot.test.mjs fails at 80% of it, and the snapshot script refuses a merge that
// would drop rows.
export const MAX_RELEASES_PER_SOURCE = 1000;

const LINE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;

/** True for a value a release may carry as `line`: a short token of letters, digits and . _ - */
export function isLine(value) {
  return typeof value === 'string' && LINE_RE.test(value);
}

/**
 * The release with `line` added as its last field, or the release as it was when `line` is
 * not a valid token. Used by the adapters whose family has several lines.
 */
export function withLine(release, line) {
  return isLine(line) ? { ...release, line } : release;
}

const ZONES = {
  Z: 0,
  UT: 0,
  GMT: 0,
  EST: -5,
  EDT: -4,
  CST: -6,
  CDT: -5,
  MST: -7,
  MDT: -6,
  PST: -8,
  PDT: -7,
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const DATE_RE =
  /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([A-Za-z]{1,3}|[+-]\d{4})?$/;

/** RFC 822 date (named or numeric zone) to ISO-8601 UTC, or null when it cannot be read. */
export function parseDate(text) {
  const m = DATE_RE.exec(String(text ?? '').trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  let year = Number(m[3]);
  if (m[3].length === 2) year += year < 50 ? 2000 : 1900;
  const zone = m[7] ?? 'GMT';
  let offsetMinutes;
  if (/^[+-]\d{4}$/.test(zone)) {
    const sign = zone[0] === '-' ? -1 : 1;
    offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
  } else if (Object.hasOwn(ZONES, zone.toUpperCase())) {
    offsetMinutes = ZONES[zone.toUpperCase()] * 60;
  } else {
    return null;
  }
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] ?? 0);
  if (hour > 23 || minute > 59 || second > 60) return null;
  const day = Number(m[1]);
  // Date.UTC rolls an impossible date (31 Sep, day 0) over silently; refuse it instead.
  const local = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month || local.getUTCDate() !== day) {
    return null;
  }
  const ms = local.getTime() - offsetMinutes * 60000;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, name) => {
    const lower = name.toLowerCase();
    if (lower[0] === '#') {
      const code = lower[1] === 'x' ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[lower];
  });
}

/**
 * The text of the first <tag> in a chunk of XML. CDATA is taken literally; anything else
 * has its entities decoded exactly once.
 */
export function field(item, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(item);
  if (!m) return '';
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(m[1]);
  return (cdata ? cdata[1] : decodeEntities(m[1])).trim();
}

/** The inner text of every <item> in an RSS document. */
export function rssItems(xmlText) {
  return [...String(xmlText ?? '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
}

/** True for an https URL on exactly this host. */
export function isHttpsOn(value, hostname) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === hostname;
  } catch {
    return false;
  }
}

function byNewest(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function union(a, b) {
  const byId = new Map();
  for (const list of [a, b]) {
    for (const release of Array.isArray(list) ? list : []) {
      if (release && typeof release.id === 'string' && release.id) {
        byId.set(release.id, release);
      }
    }
  }
  return [...byId.values()].sort(byNewest);
}

/** Union of releases by id (later entries win), newest first, with no cap. For adapters. */
export function sortReleases(list) {
  return union(list, []);
}

/**
 * Union of two release lists by id (entries in `b` win), newest first, each source capped at
 * its newest MAX_RELEASES_PER_SOURCE. Returns { releases, dropped }: `dropped` maps a source
 * id to the number of its rows the cap removed (empty when none).
 */
export function mergeReleasesChecked(a, b) {
  const kept = new Map();
  const dropped = {};
  const releases = [];
  for (const release of union(a, b)) {
    const key = typeof release.source === 'string' ? release.source : '';
    const count = kept.get(key) ?? 0;
    if (count < MAX_RELEASES_PER_SOURCE) {
      kept.set(key, count + 1);
      releases.push(release);
    } else {
      dropped[key] = (dropped[key] ?? 0) + 1;
    }
  }
  return { releases, dropped };
}

/** mergeReleasesChecked without the report: the merged list alone. */
export function mergeReleases(a, b) {
  return mergeReleasesChecked(a, b).releases;
}
