#!/usr/bin/env node
// Refresh src/data/releases.json from every source in the registry.
//
//   node deploy/snapshot_releases.mjs
//
// The Worker serves live data and falls back to this file, and the site reads it when no
// Worker answers (the local preview). A feed holds only its latest items, so the new items
// are merged into what the file already has and history accumulates. Each source is
// fetched on its own: one that fails keeps its old releases and the others still update,
// but the script then exits non-zero so the failure is seen. No dependencies: node 22 and
// the same adapters and fetch the Worker uses.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_RELEASES_PER_SOURCE, mergeReleasesChecked } from './releases.js';
import { SOURCES } from './sources/index.js';
import { fetchParts } from './worker.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'src', 'data', 'releases.json');

// Only a missing file means "no snapshot yet". A file that cannot be read or parsed, or has
// no releases list, stops the script with the file untouched: starting from the feeds alone
// would drop all the history a feed no longer carries.
let existing = [];
let text = null;
try {
  text = readFileSync(target, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error(`cannot read ${target}: ${error.message}`);
    process.exit(1);
  }
}
if (text !== null) {
  try {
    existing = JSON.parse(text).releases;
  } catch (error) {
    console.error(`${target} is not valid JSON (${error.message}); it is left untouched`);
    process.exit(1);
  }
  if (!Array.isArray(existing)) {
    console.error(`${target} has no releases list; it is left untouched`);
    process.exit(1);
  }
}

let releases = existing;
const failures = [];
for (const source of SOURCES) {
  try {
    // The Worker's own fetch: its accept header, 2 MiB body cap and 8 s deadline per source.
    const found = (await fetchParts(source)).flat();
    if (found.length === 0) {
      throw new Error('the source held no releases');
    }
    const merged = mergeReleasesChecked(
      releases,
      found.map((release) => ({ ...release, vendor: source.vendor, source: source.id })),
    );
    // The cap must never drop rows quietly: keep the old file's rows for this source and fail.
    const lost = Object.entries(merged.dropped);
    if (lost.length > 0) {
      const names = lost.map(([id, n]) => `${id || '(no source)'}: ${n} row(s)`).join(', ');
      throw new Error(
        `merging would drop ${names} over the cap of ${MAX_RELEASES_PER_SOURCE} per source; ` +
          'raise MAX_RELEASES_PER_SOURCE in deploy/releases.js on purpose',
      );
    }
    releases = merged.releases;
  } catch (error) {
    // The Worker's message starts with the source id already; the URLs are the allowlist.
    const reason = error.message.startsWith(`${source.id} `)
      ? error.message.slice(source.id.length + 1)
      : error.message;
    failures.push(`${source.id}: ${reason} (${source.urls.join(', ')})`);
  }
}
if (failures.length === SOURCES.length) {
  throw new Error(`no source answered; the snapshot is unchanged (${failures.join('; ')})`);
}

const payload = {
  source: SOURCES.map((source) => source.id).join(','),
  fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  stale: false,
  snapshot: true,
  releases,
};
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);

const counts = {};
for (const release of payload.releases) {
  const key = `${release.vendor}/${release.family}`;
  counts[key] = (counts[key] ?? 0) + 1;
}
console.log(`${payload.releases.length} releases`, JSON.stringify(counts));
console.log(`newest: ${payload.releases[0].title} ${payload.releases[0].date}`);
for (const failure of failures) {
  console.error(`failed: ${failure}`);
}
if (failures.length > 0) {
  process.exitCode = 1;
}
