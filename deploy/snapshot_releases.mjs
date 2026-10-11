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
// the same adapters the Worker uses.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeReleases } from './releases.js';
import { SOURCES } from './sources/index.js';

const USER_AGENT = 'orbit (+https://orbit.szolotov.com)';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'src', 'data', 'releases.json');

let existing = [];
try {
  existing = JSON.parse(readFileSync(target, 'utf8')).releases ?? [];
} catch {
  // No snapshot yet, or an unreadable one: start from the feeds alone.
}

let releases = existing;
const failures = [];
for (const source of SOURCES) {
  try {
    const found = [];
    for (const url of source.urls) {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'user-agent': USER_AGENT },
      });
      if (res.status !== 200) {
        throw new Error(`${url} answered ${res.status}`);
      }
      found.push(...source.parse(await res.text()));
    }
    if (found.length === 0) {
      throw new Error('the source held no releases');
    }
    releases = mergeReleases(
      releases,
      found.map((release) => ({ ...release, vendor: source.vendor, source: source.id })),
    );
  } catch (error) {
    failures.push(`${source.id}: ${error.message}`);
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
