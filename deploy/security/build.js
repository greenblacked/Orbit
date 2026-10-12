// Build the security payload (schema 1, ADR 0008) from what the adapters read. Pure: no I/O and
// no clock, so the same input gives the same bytes and a test can run it on fixtures.
//
// Per source, fail closed: if the index could not be read, the source keeps what the previous
// payload held for it and is marked `failed`, so a broken page never turns into a made-up "0".

export const MAX_PAGES = 40;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A copy of `map` with its keys in code unit order. */
function sortedMap(map) {
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => compare(a, b)));
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function entry(status, checkedAt, notes = [], cves = [], count = null) {
  return { status, notes, cves, count, patchLevel: null, checkedAt };
}

/**
 * The note pages a source needs, in release order: the page of every released build that matches
 * a row with CVE entries, once each, at most `cap` of them.
 */
export function neededPages(adapter, releases, rows, cap = MAX_PAGES) {
  const urls = [];
  for (const found of adapter.match(releases, rows)) {
    const url = found.status === 'matched' && !found.row.noCveEntries ? found.row.note : null;
    if (url && !urls.includes(url) && urls.length < cap) urls.push(url);
  }
  return urls;
}

// The note of one page, or null when the page does not read as the security content of the
// release (no heading, no CVE id, or products that do not include the release's own).
function noteOf(adapter, html, release) {
  const page = typeof html === 'string' ? adapter.parseNote(html) : null;
  if (!page || page.cves.length === 0) return null;
  const family = release.family;
  const version = String(release.version).replace(/(\.0)+$/, '');
  const names = page.products.some(
    (p) => p.family === family && p.version.replace(/(\.0)+$/, '') === version,
  );
  if (page.products.length > 0 && !names) return null;
  return {
    source: adapter.id,
    title: page.title,
    published: page.released ?? null,
    cves: page.cves.map((id) => ({ id, severity: null })),
    noCveEntries: false,
  };
}

/**
 * The payload for `releases` (the rows of releases.json).
 *
 *   previous  the payload now on disk, or null
 *   sources   [{ adapter, rows, pages }]: `rows` is the parsed index (null or empty when it could
 *             not be read) and `pages` maps a note URL to its HTML (a missing URL failed)
 *   now       the ISO timestamp to write as generatedAt and checkedAt
 *
 * Returns { payload, failures }: `failures` lists every source and page that could not be read.
 */
export function buildPayload({ previous, releases, sources, now }) {
  const before = isObject(previous) && previous.schema === 1 ? previous : {};
  const ids = new Set(releases.map((release) => release.id));
  const failures = [];
  const outSources = isObject(before.sources) ? { ...before.sources } : {};
  const outNotes = isObject(before.notes) ? { ...before.notes } : {};
  const outReleases = {};
  if (isObject(before.releases)) {
    for (const [id, value] of Object.entries(before.releases)) {
      if (ids.has(id)) outReleases[id] = value;
    }
  }

  for (const { adapter, rows, pages } of sources) {
    const mine = releases.filter((release) => release.vendor === adapter.vendor);
    const failed = !Array.isArray(rows) || rows.length === 0;
    if (failed) failures.push(`${adapter.id}: the index could not be read`);
    const old = outSources[adapter.id];
    outSources[adapter.id] = failed
      ? { status: 'failed', checkedAt: old?.checkedAt ?? now, index: adapter.index }
      : { status: 'ok', checkedAt: now, index: adapter.index };

    if (failed) {
      // Keep what the last good run read; a release it never covered is unavailable.
      for (const release of mine) {
        if (release.stage !== 'release') outReleases[release.id] = entry('not-applicable', now);
        else if (!outReleases[release.id]) outReleases[release.id] = entry('unavailable', now);
      }
      continue;
    }

    const kept = { ...outNotes };
    for (const [url, note] of Object.entries(outNotes)) {
      if (note?.source === adapter.id) delete outNotes[url];
    }
    const byId = new Map(mine.map((release) => [release.id, release]));
    for (const found of adapter.match(releases, rows)) {
      const release = byId.get(found.id);
      if (found.status === 'not-applicable') {
        outReleases[found.id] = entry('not-applicable', now);
      } else if (found.status === 'not-found') {
        outReleases[found.id] = entry('not-found', now);
      } else if (found.row.noCveEntries) {
        outReleases[found.id] = entry('no-cve-entries', now, [], [], 0);
      } else {
        const url = found.row.note;
        const note = noteOf(adapter, pages?.get(url), release) ?? outNotes[url] ?? kept[url];
        const usable = note && note.source === adapter.id && note.cves.length > 0;
        if (usable) {
          outNotes[url] = note;
          const cves = note.cves.map((cve) => cve.id);
          outReleases[found.id] = entry('listed', now, [url], cves, cves.length);
        } else {
          failures.push(`${adapter.id}: no usable note for ${release.title ?? found.id} (${url})`);
          outReleases[found.id] = entry('unavailable', now);
        }
      }
    }
  }

  // A note that no release refers to any more is dropped.
  const used = new Set(Object.values(outReleases).flatMap((value) => value.notes ?? []));
  for (const url of Object.keys(outNotes)) {
    if (!used.has(url)) delete outNotes[url];
  }

  return {
    payload: {
      schema: 1,
      generatedAt: now,
      sources: sortedMap(outSources),
      notes: sortedMap(outNotes),
      releases: sortedMap(outReleases),
    },
    failures,
  };
}
