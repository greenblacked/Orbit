// Tests for the MikroTik adapter: the NEWEST text files and the RouterOS RSS feed, on
// fixtures copied from the probe of 2026-10-12.
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
  RSS_URL,
  makeRelease,
  parse,
  parseFeed,
  parseNewest,
  unixToIso,
} from '../deploy/sources/mikrotik.js';
import { createWorker } from '../deploy/worker.js';
import { fakeCtx, fakeEnv, ORIGIN, stubUpstream, useHarness } from './support/harness.mjs';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/mikrotik/${name}`, import.meta.url)), 'utf8');
const FEED = fixture('latest-stable-and-long-term.rss');
const STABLE = fixture('NEWESTa7.stable');
const LONG_TERM = fixture('NEWESTa7.long-term');
const TESTING = fixture('NEWESTa7.testing');

// What each verified URL answers, by URL.
const DOCUMENTS = {
  [RSS_URL]: FEED,
  [NEWEST_URLS.stable]: STABLE,
  [NEWEST_URLS['long-term']]: LONG_TERM,
  [NEWEST_URLS.testing]: TESTING,
};

const KEYS = [
  'beta', 'build', 'date', 'family', 'id', 'major', 'source', 'stage', 'title', 'url',
  'vendor', 'version',
];

const item = (title, link, pubDate) =>
  `<item><title>${title}</title><link>${link}</link><guid>${title}</guid><pubDate>${pubDate}</pubDate></item>`;
const rss = (...items) => `<?xml version="1.0"?><rss><channel>${items.join('')}</channel></rss>`;
const DATE = 'Fri, 09 Oct 2026 08:23:57 +0000';
const LINK = 'https://mikrotik.com/download?v=7.23.8';

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
    assert.equal(release.version, '7.25rc1');
    assert.equal(release.stage, 'rc');
    assert.equal(release.beta, 1);
    assert.equal(release.major, 7);
    assert.equal(release.build, '7.25rc1');
    assert.equal(release.title, 'RouterOS 7.25rc1');
    assert.equal(release.date, '2026-10-01T14:18:48Z');
    assert.equal(parseNewest('7.25beta2 1790864328\n', 'testing')[0].stage, 'beta');
    assert.equal(parseNewest('7.25beta2 1790864328\n', 'testing')[0].beta, 2);
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

describe('the RSS feed', () => {
  it('reads the stable and long-term items, newest first', () => {
    const releases = parseFeed(FEED);
    assert.deepEqual(
      releases.map((r) => [r.id, r.title, r.date, r.url]),
      [
        [
          'routeros-7.23.8-long-term',
          'RouterOS 7.23.8 long-term',
          '2026-10-09T08:23:57Z',
          'https://mikrotik.com/download?v=7.23.8',
        ],
        [
          'routeros-7.24.5-stable',
          'RouterOS 7.24.5 stable',
          '2026-10-01T07:59:16Z',
          'https://mikrotik.com/download?v=7.24.5',
        ],
      ],
    );
    for (const release of releases) {
      assert.deepEqual(Object.keys(release).sort(), KEYS);
      assert.equal(release.source, ID);
      assert.equal(release.stage, 'release');
      assert.equal(release.beta, null);
      assert.equal(release.build, release.version);
    }
  });

  it('never keeps the release notes', () => {
    const text = JSON.stringify(parseFeed(FEED));
    assert.ok(FEED.includes("What's new in 7.24.5"), 'the fixture does carry notes');
    assert.doesNotMatch(text, /What's new|bridge|DHCP|wifi|ospf/);
  });

  it('skips items it cannot trust', () => {
    const feed = rss(
      item('RouterOS 7.23.8 [long-term]', LINK, DATE),
      item('RouterOS 7.23.7 [nightly]', LINK, DATE),
      item('RouterOS 7.23.6 [long-term]', 'http://mikrotik.com/download?v=7.23.6', DATE),
      item('RouterOS 7.23.5 [long-term]', 'https://evil.example/download?v=7.23.5', DATE),
      item('RouterOS 7.23.4 [long-term]', 'https://mikrotik.com.evil.example/x', DATE),
      item('RouterOS 7.23.3 [long-term]', 'not a url', DATE),
      item('RouterOS 7.23.2 [long-term]', LINK, 'yesterday'),
      item('RouterOS 7.23.1 [long-term]', LINK, ''),
      item('RouterOS 7.25rc1 [stable]', LINK, DATE),
      item('RouterOS 7.23.8', LINK, DATE),
      item('Winbox 4.0 [stable]', LINK, DATE),
      item('RouterOS  [stable]', LINK, DATE),
      '<item><link>https://mikrotik.com/download?v=7.0</link></item>',
    );
    assert.deepEqual(
      parseFeed(feed).map((r) => r.id),
      ['routeros-7.23.8-long-term'],
    );
  });

  it('reads a testing item as a pre-release', () => {
    const [release] = parseFeed(rss(item('RouterOS 7.25beta3 [testing]', LINK, DATE)));
    assert.equal(release.stage, 'beta');
    assert.equal(release.beta, 3);
    assert.equal(release.title, 'RouterOS 7.25beta3');
  });

  it('is empty for an empty or unreadable document', () => {
    for (const text of ['', '   ', 'not xml', '<rss><channel></channel></rss>', '<html></html>']) {
      assert.deepEqual(parseFeed(text), [], JSON.stringify(text));
    }
    assert.deepEqual(parseFeed(undefined), []);
    assert.deepEqual(parseFeed(null), []);
  });
});

describe('makeRelease', () => {
  it('refuses an unknown channel, a missing date and a link off the vendor host', () => {
    const base = { version: '7.24.5', channel: 'stable', date: '2026-09-29T14:21:27Z' };
    assert.ok(makeRelease(base));
    assert.equal(makeRelease({ ...base, channel: 'nightly' }), null);
    assert.equal(makeRelease({ ...base, date: null }), null);
    assert.equal(makeRelease({ ...base, url: 'https://example.com/x' }), null);
    assert.equal(makeRelease({ ...base, version: '7.24.5 ' }), null);
    assert.equal(makeRelease({ ...base, version: undefined }), null);
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
      'https://download.mikrotik.com/routeros/latest-stable-and-long-term.rss',
      'https://upgrade.mikrotik.com/routeros/NEWESTa7.stable',
      'https://upgrade.mikrotik.com/routeros/NEWESTa7.long-term',
      'https://upgrade.mikrotik.com/routeros/NEWESTa7.testing',
    ]);
    for (const url of mikrotik.urls) {
      assert.ok(['download.mikrotik.com', 'upgrade.mikrotik.com'].includes(new URL(url).hostname));
      assert.doesNotMatch(url, /NEWEST7/, 'NEWEST7.* and NEWEST7a.* are not the verified names');
    }
  });

  it('parses each document by its URL, and nothing it does not know', () => {
    assert.equal(parse(FEED, RSS_URL).length, 2);
    assert.equal(parse(STABLE, NEWEST_URLS.stable)[0].id, 'routeros-7.24.5-stable');
    assert.equal(parse(LONG_TERM, NEWEST_URLS['long-term'])[0].id, 'routeros-7.23.8-long-term');
    assert.equal(parse(TESTING, NEWEST_URLS.testing)[0].id, 'routeros-7.25rc1-testing');
    assert.deepEqual(parse(STABLE), []);
    assert.deepEqual(parse(STABLE, 'https://upgrade.mikrotik.com/routeros/NEWEST7.stable'), []);
    assert.deepEqual(parse(STABLE, 'https://evil.example/NEWESTa7.stable'), []);
    assert.deepEqual(parse(FEED, NEWEST_URLS.stable), []);
  });

  it('merges the documents into one list, the NEWEST timestamps winning', () => {
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
