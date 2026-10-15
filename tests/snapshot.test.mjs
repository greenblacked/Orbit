// The snapshot script talks to the sources, so the tests do not run it; they check that it
// parses, that every module it imports resolves, and that the snapshot it writes keeps to
// the multi-vendor data contract.
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FAMILIES } from '../deploy/families.js';
import { MAX_RELEASES_PER_SOURCE, SUMMARY_MAX, cleanSummary } from '../deploy/releases.js';
import { SOURCES } from '../deploy/sources/index.js';

const script = fileURLToPath(new URL('../deploy/snapshot_releases.mjs', import.meta.url));
const snapshotFile = fileURLToPath(new URL('../src/data/releases.json', import.meta.url));

describe('deploy/snapshot_releases.mjs', () => {
  it('parses', () => {
    const result = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });

  it('imports only files that exist, and Node built-ins', () => {
    const source = readFileSync(script, 'utf8');
    const specs = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.ok(specs.length > 0);
    for (const spec of specs) {
      if (spec.startsWith('node:')) continue;
      assert.ok(spec.startsWith('./'), `${spec} must be a sibling file`);
      assert.ok(existsSync(new URL(spec, new URL(`file://${script}`))), `${spec} is missing`);
    }
  });

  it('goes through the registry, not a feed of its own', () => {
    const source = readFileSync(script, 'utf8');
    assert.match(source, /from '\.\/sources\/index\.js'/);
    assert.doesNotMatch(source, /developer\.apple\.com/);
  });

  it('follows no redirect away from a source URL', () => {
    assert.match(readFileSync(script, 'utf8'), /redirect: 'manual'/);
  });

  it('starts from nothing only when there is no snapshot file, and aborts otherwise', () => {
    const source = readFileSync(script, 'utf8');
    assert.match(source, /error\.code !== 'ENOENT'/);
    assert.match(source, /is not valid JSON[^\n]*left untouched/);
    assert.match(source, /Array\.isArray\(existing\)/);
    assert.doesNotMatch(source, /\?\? \[\]/, 'no silent fallback to an empty list');
  });

  it('fails a source whose merge would drop rows over the cap, naming it', () => {
    const source = readFileSync(script, 'utf8');
    assert.match(source, /mergeReleasesChecked\(/);
    assert.match(source, /merged\.dropped/);
    assert.match(source, /merging would drop \$\{names\}/);
    assert.match(source, /failures\.push\(`\$\{source\.id\}: /);
  });
});

describe('src/data/releases.json', () => {
  const payload = JSON.parse(readFileSync(snapshotFile, 'utf8'));
  const keys = [
    'beta', 'build', 'date', 'family', 'id', 'major', 'source', 'stage', 'title', 'url',
    'vendor', 'version',
  ];

  it('has the payload shape', () => {
    assert.deepEqual(Object.keys(payload), ['source', 'fetchedAt', 'stale', 'snapshot', 'releases']);
    assert.equal(payload.snapshot, true);
    assert.ok(Number.isFinite(Date.parse(payload.fetchedAt)));
    assert.ok(payload.releases.length > 0);
  });

  it('gives every release the whole contract, from a registered source and a known family', () => {
    const ids = new Set(SOURCES.map((s) => s.id));
    for (const r of payload.releases) {
      // Two optional keys. `line`: RouterOS and Windows carry it, every other family not.
      // `summary`: a short plain line from the adapter or an owner note (ADR 0008 keeps
      // security notes out of this file; a summary is not one).
      const expected = r.family === 'RouterOS' || r.family === 'Windows' ? [...keys, 'line'] : keys;
      assert.deepEqual(Object.keys(r).filter((k) => k !== 'summary').sort(), [...expected].sort(), r.id);
      if ('summary' in r) {
        assert.equal(typeof r.summary, 'string', r.id);
        assert.equal(r.summary, cleanSummary(r.summary), r.id);
        assert.ok(r.summary.length > 0 && r.summary.length <= SUMMARY_MAX, r.id);
      }
      assert.ok(ids.has(r.source), `${r.id}: unknown source ${r.source}`);
      const source = SOURCES.find((s) => s.id === r.source);
      assert.equal(r.vendor, source.vendor, r.id);
      assert.ok(
        FAMILIES.some((f) => f.id === r.family && f.vendor === r.vendor),
        `${r.id}: unknown family ${r.family}`,
      );
      assert.ok(['release', 'beta', 'rc'].includes(r.stage), r.id);
      assert.match(r.date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      // Only Apple posts always carry a build; other sources may have none.
      assert.ok((r.vendor !== 'apple' || r.build.length > 0) && r.title.length > 0, r.id);
    }
  });

  it('is newest first with unique ids', () => {
    assert.equal(new Set(payload.releases.map((r) => r.id)).size, payload.releases.length);
    for (let i = 1; i < payload.releases.length; i += 1) {
      assert.ok(payload.releases[i - 1].date >= payload.releases[i].date, `${i} is out of order`);
    }
  });

  it('keeps every source under 80% of the per-source cap', () => {
    const counts = {};
    for (const r of payload.releases) counts[r.source] = (counts[r.source] ?? 0) + 1;
    const limit = MAX_RELEASES_PER_SOURCE * 0.8;
    for (const [id, n] of Object.entries(counts)) {
      assert.ok(
        n <= limit,
        `${id} holds ${n} rows, within 20% of the cap of ${MAX_RELEASES_PER_SOURCE}: ` +
          'raise MAX_RELEASES_PER_SOURCE in deploy/releases.js on purpose before it drops rows',
      );
    }
  });
});
