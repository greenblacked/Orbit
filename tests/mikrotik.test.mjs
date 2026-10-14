// Tests for the MikroTik adapter: the NEWEST text files, on fixtures copied from the probe
// of 2026-10-12.
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { familyIds } from '../deploy/families.js';
import { mergeReleases } from '../deploy/releases.js';
import { isSource } from '../deploy/sources/index.js';
import mikrotik, {
  FAMILY,
  ID,
  NEWEST_URLS,
  makeRelease,
  parse,
  parseNewest,
  summaryOfChannel,
  unixToIso,
} from '../deploy/sources/mikrotik.js';
import { createWorker } from '../deploy/worker.js';
import { fakeCtx, fakeEnv, ORIGIN, stubUpstream, useHarness } from './support/harness.mjs';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/mikrotik/${name}`, import.meta.url)), 'utf8');
const STABLE = fixture('NEWESTa7.stable');
const LONG_TERM = fixture('NEWESTa7.long-term');
const TESTING = fixture('NEWESTa7.testing');

// What each verified URL answers, by URL.
const DOCUMENTS = {
  [NEWEST_URLS.stable]: STABLE,
  [NEWEST_URLS['long-term']]: LONG_TERM,
  [NEWEST_URLS.testing]: TESTING,
};

const KEYS = [
  'beta', 'build', 'date', 'family', 'id', 'major', 'source', 'stage', 'title', 'url',
  'vendor', 'version',
];

describe('unixToIso', () => {
  it('converts seconds to ISO-8601 UTC without milliseconds', () => {
    assert.equal(unixToIso('1790691687'), '2026-09-29T14:21:27Z');
    assert.equal(unixToIso('1791452776'), '2026-10-08T09:46:16Z');
    assert.equal(unixToIso('1790864328'), '2026-10-01T14:18:48Z');
  });

  it('refuses what is not a plausible time', () => {
    for (const bad of ['', 'abc', '0', '-5', '1.5', '99999999999', null, undefined]) {
      assert.equal(unixToIso(bad), null, String(bad));
    }
  });
});

describe('the NEWEST documents', () => {
  it('reads a stable release', () => {
    assert.deepEqual(parseNewest(STABLE, 'stable'), [
      {
        id: 'routeros-7.24.5-stable',
        vendor: 'mikrotik',
        family: 'RouterOS',
        version: '7.24.5',
        major: 7,
        stage: 'release',
        beta: null,
        build: '7.24.5',
        title: 'RouterOS 7.24.5 stable',
        date: '2026-09-29T14:21:27Z',
        url: 'https://mikrotik.com/download?v=7.24.5',
        source: ID,
        summary: 'Stable channel release',
      },
    ]);
  });

  it('keeps the channel in the title of a long-term release', () => {
    const [release] = parseNewest(LONG_TERM, 'long-term');
    assert.equal(release.title, 'RouterOS 7.23.8 long-term');
    assert.equal(release.id, 'routeros-7.23.8-long-term');
    assert.equal(release.stage, 'release');
    assert.equal(release.date, '2026-10-08T09:46:16Z');
  });

  it('marks a testing release as a pre-release with its iteration', () => {
    const [release] = parseNewest(TESTING, 'testing');
    assert.equal(release.version, '7.25');
    assert.equal(release.stage, 'rc');
    assert.equal(release.beta, 1);
    assert.equal(release.major, 7);
    assert.equal(release.build, '7.25rc1');
    assert.equal(release.title, 'RouterOS 7.25rc1');
    assert.equal(release.date, '2026-10-01T14:18:48Z');
    assert.equal(release.url, 'https://mikrotik.com/download?v=7.25rc1');
    assert.deepEqual(Object.keys(release).filter((k) => k !== 'summary').sort(), KEYS);
    const beta = parseNewest('7.25.1beta2 1790864328\n', 'testing')[0];
    assert.deepEqual([beta.stage, beta.beta, beta.version, beta.build], ['beta', 2, '7.25.1', '7.25.1beta2']);
  });

  it('summarises a release by its channel, from the file it came from', () => {
    assert.equal(parseNewest(LONG_TERM, 'long-term')[0].summary, 'Long-term channel release');
    assert.equal(parseNewest(TESTING, 'testing')[0].summary, 'Testing channel pre-release');
    assert.equal(summaryOfChannel('nightly', false), '');
  });

  it('keeps a pre-release out of the stable channels and a plain version out of testing', () => {
    assert.deepEqual(parseNewest(TESTING, 'stable'), []);
    assert.deepEqual(parseNewest(TESTING, 'long-term'), []);
    assert.deepEqual(parseNewest(STABLE, 'testing'), []);
  });

  it('skips anything malformed', () => {
    for (const bad of [
      '',
      '\n',
      'garbage',
      '7.24.5',
      '7.24.5 ',
      '7.24.5 soon',
      '7.24.5 0',
      '7.24.5 99999999999',
      '7.24.5 1790691687 extra',
      '7.24.5\t1790691687',
      '7 1790691687',
      'v7.24.5 1790691687',
      '7.24.5.1 1790691687',
      '<html>404</html>',
      `7.24.5 1790691687\n${'x'.repeat(300)}`,
    ]) {
      assert.deepEqual(parseNewest(bad, 'stable'), [], JSON.stringify(bad));
    }
    assert.deepEqual(parseNewest(STABLE, 'nightly'), []);
    assert.deepEqual(parseNewest(undefined, 'stable'), []);
  });
});

describe('makeRelease', () => {
  it('refuses an unknown channel, a missing date and a date from the future', () => {
    const base = { version: '7.24.5', channel: 'stable', date: '2026-09-29T14:21:27Z' };
    assert.ok(makeRelease(base));
    assert.equal(makeRelease({ ...base, channel: 'nightly' }), null);
    assert.equal(makeRelease({ ...base, date: null }), null);
    const now = Date.parse('2026-10-12T12:00:00Z');
    assert.ok(makeRelease({ ...base, now }));
    assert.equal(makeRelease({ ...base, date: '2026-10-13T11:00:00Z', now })?.id, 'routeros-7.24.5-stable');
    assert.equal(makeRelease({ ...base, date: '2026-10-13T13:00:00Z', now }), null);
    assert.equal(makeRelease({ ...base, date: unixToIso('4102444799'), now }), null);
    assert.equal(makeRelease({ ...base, version: '7.24.5 ' }), null);
    assert.equal(makeRelease({ ...base, version: undefined }), null);
  });

  it('builds the link from the version, whatever else is passed', () => {
    const base = { version: '7.24.5', channel: 'stable', date: '2026-09-29T14:21:27Z' };
    assert.equal(
      makeRelease({ ...base, url: 'https://mikrotik.com/login' }).url,
      'https://mikrotik.com/download?v=7.24.5',
    );
  });
});

describe('the adapter', () => {
  it('has the shape of a registered source, for a family of its own vendor', () => {
    assert.equal(isSource(mikrotik), true);
    assert.equal(mikrotik.vendor, 'mikrotik');
    assert.ok(familyIds('mikrotik').includes(FAMILY));
  });

  it('fetches only the verified URLs, over https on fixed hosts', () => {
    assert.deepEqual(mikrotik.urls, [
      'https://upgrade.mikrotik.com/routeros/NEWESTa7.stable',
      'https://upgrade.mikrotik.com/routeros/NEWESTa7.long-term',
      'https://upgrade.mikrotik.com/routeros/NEWESTa7.testing',
    ]);
    for (const url of mikrotik.urls) {
      assert.equal(new URL(url).hostname, 'upgrade.mikrotik.com');
      assert.doesNotMatch(url, /NEWEST7/, 'NEWEST7.* and NEWEST7a.* are not the verified names');
    }
  });

  it('parses each document by its URL, and nothing it does not know', () => {
    assert.equal(parse(STABLE, NEWEST_URLS.stable)[0].id, 'routeros-7.24.5-stable');
    assert.equal(parse(LONG_TERM, NEWEST_URLS['long-term'])[0].id, 'routeros-7.23.8-long-term');
    assert.equal(parse(TESTING, NEWEST_URLS.testing)[0].id, 'routeros-7.25rc1-testing');
    assert.deepEqual(parse(STABLE), []);
    assert.deepEqual(parse(STABLE, 'https://upgrade.mikrotik.com/routeros/NEWEST7.stable'), []);
    assert.deepEqual(parse(STABLE, 'https://evil.example/NEWESTa7.stable'), []);
    assert.deepEqual(parse(STABLE, 'https://download.mikrotik.com/routeros/latest-stable-and-long-term.rss'), []);
  });

  it('merges the documents into one list, newest first', () => {
    const found = mikrotik.urls.flatMap((url) => parse(DOCUMENTS[url], url));
    const merged = mergeReleases([], found);
    assert.deepEqual(
      merged.map((r) => [r.title, r.date]),
      [
        ['RouterOS 7.23.8 long-term', '2026-10-08T09:46:16Z'],
        ['RouterOS 7.25rc1', '2026-10-01T14:18:48Z'],
        ['RouterOS 7.24.5 stable', '2026-09-29T14:21:27Z'],
      ],
    );
  });
});

describe('the Worker with the MikroTik source', () => {
  useHarness();

  it('fetches every URL, tells the adapter which one, and serves the merged releases', async () => {
    stubUpstream((url) => new Response(DOCUMENTS[url], { status: 200 }));
    const worker = createWorker([mikrotik]);
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/releases.json?vendor=mikrotik`),
      fakeEnv(),
      fakeCtx(),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, ID);
    assert.deepEqual(
      body.releases.map((r) => r.title),
      ['RouterOS 7.23.8 long-term', 'RouterOS 7.25rc1', 'RouterOS 7.24.5 stable'],
    );
    assert.ok(body.releases.every((r) => r.vendor === 'mikrotik' && r.source === ID));
  });
});
