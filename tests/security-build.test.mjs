// The security payload built from both adapters (Apple and Android) on the recorded fixtures,
// with no network: the shared contract, and the rule that one failing source never wipes another.
// Releases and patch levels marked synthetic are made up to join a recorded page.
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import android, { bulletinUrl, parseBulletin } from '../deploy/security/android.js';
import apple, { parseIndex } from '../deploy/security/apple.js';
import { buildPayload, MAX_NOTES, pagesFor } from '../deploy/security/build.js';
import { isSecuritySource, SECURITY_SOURCES } from '../deploy/security/index.js';
import { payloadProblems } from '../deploy/security/validate.js';
import { problems } from './support/security_contract.mjs';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const INDEX = read('./fixtures/apple-security/releases-index-slice.html');
const NOTE = read('./fixtures/apple-security/note-149226-slice-1.html');
const BUILDS = read('./fixtures/google/build-numbers.html');
const AOSP = read('./fixtures/android-security/aosp-2026-10.html');

const NOTE_URL = 'https://support.apple.com/en-us/149226';
const AOSP_URL = bulletinUrl('2026-10-01');
const SEP_URL = bulletinUrl('2026-09-01');
const NOW = '2026-10-12T09:00:00Z';
const LATER = '2026-10-13T09:00:00Z';

const row = (id, vendor, family, version, stage, date) => ({
  id,
  vendor,
  family,
  version,
  stage,
  date,
  title: `${family} ${version}`,
});
const releases = [
  row('ios', 'apple', 'iOS', '26.7.1', 'release', '2026-09-28T17:00:00Z'),
  row('ios-beta', 'apple', 'iOS', '27.2', 'beta', '2026-10-05T18:00:00Z'),
  // Synthetic: an Android release whose patch level (below) is in the recorded October bulletin.
  row('droid', 'google', 'Android', '17', 'release', '2026-10-05T00:00:00Z'),
  // Real id and patch level (2026-06-05); no June bulletin is recorded, so it stays unavailable.
  row('android-17.0.0_r1', 'google', 'Android', '17', 'release', '2026-06-05T00:00:01Z'),
  row('droid-beta', 'google', 'Android', '18', 'beta', '2026-10-06T00:00:00Z'),
  row('mikrotik', 'mikrotik', 'RouterOS', '7.23', 'release', '2026-10-08T09:46:16Z'),
];

const appleRows = parseIndex(INDEX);
const levels = () => {
  const map = android.parseIndex(BUILDS);
  map.set('droid', '2026-10-05'); // synthetic
  return map;
};
// Synthetic: the recorded page with its patch level moved one month back, so it is a read
// bulletin for September that no release points at.
const SEP = AOSP.replaceAll('2026-10-01', '2026-09-01');

const appleSource = (extra = {}) => ({
  adapter: apple,
  rows: appleRows,
  pages: new Map([[NOTE_URL, NOTE]]),
  ...extra,
});
const androidSource = (extra = {}) => ({
  adapter: android,
  rows: levels(),
  pages: new Map([
    [AOSP_URL, AOSP],
    [SEP_URL, SEP],
  ]),
  ...extra,
});
const build = (sources, extra = {}) =>
  buildPayload({ previous: null, releases, sources, now: NOW, ...extra });

describe('the registry', () => {
  it('holds both adapters, each with the shape the snapshot relies on', () => {
    assert.deepEqual(SECURITY_SOURCES.map((source) => source.id), [apple.id, android.id]);
    for (const source of SECURITY_SOURCES) assert.equal(isSecuritySource(source), true, source.id);
    assert.equal(isSecuritySource({ ...android, parseBulletin: undefined }), false);
    assert.equal(isSecuritySource({ ...android, neededPages: undefined }), false);
    assert.equal(isSecuritySource({ ...android, family: undefined }), false);
    assert.equal(isSecuritySource({ ...android, bulletinUrl: undefined }), false);
    assert.equal(isSecuritySource({ ...android, lang: { param: '' } }), false);
    assert.equal(isSecuritySource({ ...android, lang: { param: 'hl', value: '' } }), false);
    assert.equal(isSecuritySource({ ...android, lang: 'en' }), false);
    assert.equal(isSecuritySource({ ...android, lang: { param: 'hl', value: 'en' } }), true);
  });

  it('names the pages each source needs', () => {
    assert.deepEqual(pagesFor(apple, releases, appleRows), [NOTE_URL]);
    const urls = pagesFor(android, releases, levels());
    assert.ok(urls.includes(AOSP_URL));
    assert.ok(urls.includes(SEP_URL));
    assert.ok(urls.includes(bulletinUrl('2026-06-01')));
    assert.equal(urls.length, 5);
    for (const url of urls) assert.ok(!url.includes('?'), url);
  });
});

describe('buildPayload with both sources', () => {
  it('passes the shared contract and describes each vendor', () => {
    const { payload, failures } = build([appleSource(), androidSource()]);
    assert.deepEqual(problems(payload, releases), []);
    assert.deepEqual(Object.keys(payload.sources).sort(), [android.id, apple.id].sort());
    assert.equal(payload.sources[apple.id].status, 'ok');
    assert.equal(payload.sources[android.id].status, 'ok');
    assert.equal(payload.releases.ios.status, 'listed');
    assert.equal(payload.releases['ios-beta'].status, 'not-applicable');
    const ids = parseBulletin(AOSP).cves.map((cve) => cve.id);
    assert.equal(payload.releases.droid.status, 'listed');
    assert.equal(payload.releases.droid.patchLevel, '2026-10-05');
    assert.deepEqual(payload.releases.droid.notes, [AOSP_URL]);
    assert.deepEqual(payload.releases.droid.cves, ids);
    assert.equal(payload.releases['android-17.0.0_r1'].status, 'unavailable');
    assert.equal(payload.releases['android-17.0.0_r1'].patchLevel, '2026-06-05');
    assert.equal(payload.releases['droid-beta'].status, 'not-applicable');
    // RouterOS has no adapter: written as not-connected, with no source (ADR 0008).
    assert.equal(payload.releases.mikrotik.status, 'not-connected');
    assert.equal('source' in payload.releases.mikrotik, false);
    assert.equal(payload.releases.ios.source, apple.id);
    assert.equal(payload.releases.droid.source, android.id);
    assert.equal('source' in payload.releases['ios-beta'], false);
    // The June bulletin was never fetched: that is reported, and nothing was invented for it.
    assert.ok(failures.some((line) => line.includes(bulletinUrl('2026-06-01'))));
    assert.equal(failures.every((line) => line.startsWith(android.id)), true);
  });

  it('keeps the bulletin of a month no release points at, for Compare', () => {
    const { payload } = build([appleSource(), androidSource()]);
    assert.equal(payload.notes[SEP_URL].source, android.id);
    assert.equal(payload.notes[NOTE_URL].source, apple.id);
    assert.deepEqual(problems(payload, releases), []);
  });

  it('is the same bytes for the same input', () => {
    const one = build([appleSource(), androidSource()]).payload;
    const two = build([appleSource(), androidSource()]).payload;
    assert.equal(JSON.stringify(one), JSON.stringify(two));
  });
});

describe('sources fail independently', () => {
  const first = () => build([appleSource(), androidSource()]).payload;

  for (const bad of [null, new Map()]) {
    it(`an Android index that cannot be read (${bad === null ? 'null' : 'empty'}) leaves Apple's data intact`, () => {
      const before = first();
      const { payload, failures } = build([appleSource(), androidSource({ rows: bad, pages: new Map() })], {
        previous: before,
        now: LATER,
      });
      assert.deepEqual(problems(payload, releases), []);
      assert.equal(failures.length, 1);
      assert.match(failures[0], new RegExp(android.id));
      assert.deepEqual(payload.sources[android.id], { ...before.sources[android.id], status: 'failed' });
      assert.equal(payload.sources[apple.id].status, 'ok');
      assert.equal(payload.sources[apple.id].checkedAt, LATER);
      assert.equal(payload.releases.ios.checkedAt, LATER);
      assert.deepEqual(payload.releases.ios.cves, before.releases.ios.cves);
      // Android keeps what it had: rows, the bulletin of the release and the unreferenced month.
      for (const id of ['droid', 'android-17.0.0_r1']) {
        assert.deepEqual(payload.releases[id], before.releases[id], id);
      }
      assert.deepEqual(payload.notes[AOSP_URL], before.notes[AOSP_URL]);
      assert.deepEqual(payload.notes[SEP_URL], before.notes[SEP_URL]);
    });
  }

  it("an Apple index that cannot be read leaves Android's data intact", () => {
    const before = first();
    const { payload, failures } = build([appleSource({ rows: null, pages: new Map() }), androidSource()], {
      previous: before,
      now: LATER,
    });
    assert.deepEqual(problems(payload, releases), []);
    assert.equal(failures.some((line) => line.startsWith(apple.id)), true);
    assert.equal(payload.sources[apple.id].status, 'failed');
    assert.equal(payload.sources[android.id].status, 'ok');
    assert.deepEqual(payload.releases.ios, before.releases.ios);
    assert.deepEqual(payload.notes[NOTE_URL], before.notes[NOTE_URL]);
    assert.equal(payload.releases.droid.status, 'listed');
    assert.equal(payload.releases.droid.checkedAt, LATER);
    assert.deepEqual(payload.releases.droid.cves, before.releases.droid.cves);
  });

  it('a first run whose Android index fails marks its releases unavailable, not empty', () => {
    const { payload } = build([appleSource(), androidSource({ rows: null, pages: new Map() })]);
    assert.equal(payload.sources[android.id].status, 'failed');
    assert.equal(payload.releases.droid.status, 'unavailable');
    assert.equal(payload.releases['droid-beta'].status, 'not-applicable');
    assert.equal(payload.releases.ios.status, 'listed');
    assert.deepEqual(problems(payload, releases), []);
  });
});

describe('Android pages that were not read', () => {
  const first = () => build([appleSource(), androidSource()]).payload;

  it('keeps the previous note and row when the page was not fetched, and reports it', () => {
    const before = first();
    const { payload, failures } = build([appleSource(), androidSource({ pages: new Map() })], {
      previous: before,
      now: LATER,
    });
    assert.deepEqual(problems(payload, releases), []);
    assert.deepEqual(payload.releases.droid, before.releases.droid);
    assert.deepEqual(payload.notes[AOSP_URL], before.notes[AOSP_URL]);
    assert.deepEqual(payload.notes[SEP_URL], before.notes[SEP_URL]);
    assert.ok(failures.some((line) => line.includes(AOSP_URL) && line.includes('not read again')));
  });

  it('never replaces a page that was read and refused by the previous note', () => {
    const before = first();
    const { payload, failures } = build(
      [appleSource(), androidSource({ pages: new Map([[AOSP_URL, '<html><h1>Not a bulletin</h1></html>']]) })],
      { previous: before, now: LATER },
    );
    assert.deepEqual(problems(payload, releases), []);
    assert.equal(payload.releases.droid.status, 'unavailable');
    assert.equal(payload.releases.droid.patchLevel, '2026-10-05');
    assert.equal(AOSP_URL in payload.notes, false);
    assert.ok(failures.some((line) => line.includes('no usable note')));
  });

  it('reports a needed month that was refused and has no previous note', () => {
    const june = bulletinUrl('2026-06-01');
    const { payload, failures } = build([
      appleSource(),
      androidSource({
        pages: new Map([
          [AOSP_URL, AOSP],
          [SEP_URL, SEP],
          [june, '<html><h1>Not a bulletin</h1></html>'],
        ]),
      }),
    ]);
    assert.deepEqual(problems(payload, releases), []);
    assert.equal(june in payload.notes, false);
    assert.ok(failures.some((line) => line.includes(june) && line.includes('no usable note')));
  });

  it('keeps a listed row whose release lost its patch level, and reports it', () => {
    const before = first();
    const rows = levels();
    rows.delete('droid');
    const { payload, failures } = build([appleSource(), androidSource({ rows })], {
      previous: before,
      now: LATER,
    });
    assert.deepEqual(problems(payload, releases), []);
    assert.deepEqual(payload.releases.droid, before.releases.droid);
    assert.ok(failures.some((line) => line.includes('no longer has a patch level')));
  });
});

describe('families without an adapter', () => {
  const more = [
    ...releases,
    row('win', 'microsoft', 'Windows', '11 26H1', 'release', '2026-10-01T00:00:00Z'),
    row('win-beta', 'microsoft', 'Windows', '11 26H2', 'beta', '2026-10-02T00:00:00Z'),
    row('steam', 'valve', 'SteamOS', '3.8', 'release', '2026-10-03T00:00:00Z'),
    row('steam-beta', 'valve', 'SteamOS', '3.9', 'preview', '2026-10-04T00:00:00Z'),
    row('mikrotik-rc', 'mikrotik', 'RouterOS', '7.24rc1', 'rc', '2026-10-09T00:00:00Z'),
  ];
  const run = (extra = {}) =>
    buildPayload({ previous: null, releases: more, sources: [appleSource(), androidSource()], now: NOW, ...extra });

  it('writes not-connected for a released build and not-applicable for its pre-releases', () => {
    const { payload } = run();
    assert.deepEqual(problems(payload, more), []);
    for (const id of ['mikrotik', 'win', 'steam']) {
      assert.equal(payload.releases[id].status, 'not-connected', id);
      assert.equal('source' in payload.releases[id], false, id);
    }
    for (const id of ['win-beta', 'steam-beta', 'mikrotik-rc']) {
      assert.equal(payload.releases[id].status, 'not-applicable', id);
    }
    assert.equal(Object.keys(payload.releases).length, more.length);
  });

  it('rewrites an uncovered release, keeping checkedAt only when the status is unchanged', () => {
    const before = run().payload;
    before.releases.win = {
      status: 'unavailable', notes: [], cves: [], count: null, patchLevel: null, checkedAt: NOW,
    };
    const { payload } = run({ previous: before, now: LATER });
    assert.equal(payload.releases.win.status, 'not-connected');
    assert.equal(payload.releases.win.checkedAt, LATER);
    assert.equal(payload.releases.steam.status, 'not-connected');
    assert.equal(payload.releases.steam.checkedAt, NOW);
  });
});

describe('a row with no note whose source later fails', () => {
  // A source that reads one release as "no CVE entries" with no link, like Apple's linkless rows.
  const quiet = {
    id: 'quiet',
    vendor: 'apple',
    family: null,
    kind: 'index',
    index: 'https://example.org/quiet',
    match: (all) =>
      all
        .filter((release) => release.vendor === 'apple' && release.stage === 'release')
        .map((release) => ({ id: release.id, status: 'matched', row: { noCveEntries: true, note: null } })),
  };
  const only = releases.filter((release) => release.vendor === 'apple');
  const run = (rows, previous = null, now = NOW) =>
    buildPayload({ previous, releases: only, sources: [{ adapter: quiet, rows, pages: new Map() }], now });

  it('keeps the row, records its source and marks the source failed', () => {
    const before = run([{}]).payload;
    assert.equal(before.releases.ios.status, 'no-cve-entries');
    assert.deepEqual(before.releases.ios.notes, []);
    assert.equal(before.releases.ios.source, 'quiet');
    assert.deepEqual(problems(before, only), []);

    const { payload, failures } = run(null, before, LATER);
    assert.equal(payload.sources.quiet.status, 'failed');
    assert.equal(payload.releases.ios.status, 'no-cve-entries');
    assert.equal(payload.releases.ios.checkedAt, NOW);
    assert.equal(payload.releases.ios.source, 'quiet');
    assert.equal(failures.length, 1);
    assert.deepEqual(problems(payload, only), []);
  });

  it('adds the source to a kept row an older payload wrote without one', () => {
    const before = run([{}]).payload;
    delete before.releases.ios.source;
    const { payload } = run(null, before, LATER);
    assert.equal(payload.releases.ios.source, 'quiet');
  });

  it('the contract accepts a source that is a key of sources and nothing else', () => {
    const { payload } = run([{}]);
    const bad = structuredClone(payload);
    bad.releases.ios.source = 'nope';
    assert.ok(problems(bad, only).some((line) => line.includes('ios names an unknown source')));
    const worse = structuredClone(payload);
    worse.releases['ios-beta'] = {
      status: 'not-applicable', notes: [], cves: [], count: null, patchLevel: null, checkedAt: NOW, source: 'quiet',
    };
    assert.ok(problems(worse, only).some((line) => line.includes('ios-beta is not-applicable')));
    const odd = structuredClone(payload);
    odd.releases.ios.source = 3;
    assert.ok(problems(odd, only).some((line) => line.includes('unknown source')));
  });
});

// Two fake index sources, one release per note, to cap the shared notes.
const fake = (id, vendor) => ({
  id,
  vendor,
  index: `https://${id}.example/`,
  hosts: [`${id}.example`],
  parseIndex: () => [{}],
  parseNote: () => ({ title: 't', released: null, cves: ['CVE-2026-0001'] }),
  match: (list) =>
    list
      .filter((release) => release.vendor === vendor)
      .map((release) => ({
        id: release.id,
        status: 'matched',
        row: { note: `https://${id}.example/${release.id}`, noCveEntries: false },
      })),
});
const many = (vendor, count) =>
  Array.from({ length: count }, (_, i) =>
    row(`${vendor}${i}`, vendor, 'F', '1', 'release', '2026-09-28T00:00:00Z'),
  );
const fakeSource = (adapter, list) => ({
  adapter,
  rows: [{}],
  pages: new Map(list.map((r) => [`https://${adapter.id}.example/${r.id}`, '<h1>t</h1>'])),
});

describe('the shared note cap', () => {
  const small = fake('small', 'S');
  const big = fake('big', 'B');
  const smallRows = many('S', 1);

  it('fails only the source that passes the cap; the other still writes', () => {
    const bigRows = many('B', MAX_NOTES);
    const { payload, failures } = buildPayload({
      previous: null,
      releases: [...smallRows, ...bigRows],
      sources: [fakeSource(small, smallRows), fakeSource(big, bigRows)],
      now: NOW,
    });
    assert.equal(payload.sources.small.status, 'ok');
    assert.equal(payload.sources.big.status, 'failed');
    assert.equal(payload.releases.S0.status, 'listed');
    assert.deepEqual(Object.keys(payload.notes), ['https://small.example/S0']);
    assert.equal(payload.releases.B0.status, 'unavailable');
    assert.ok(failures.some((line) => line.startsWith('big:') && line.includes('cap of 400')));
    assert.deepEqual(payloadProblems(payload), []);
  });

  it('keeps the failed source\'s previous notes and rows', () => {
    const first = buildPayload({
      previous: null,
      releases: [...smallRows, ...many('B', 1)],
      sources: [fakeSource(small, smallRows), fakeSource(big, many('B', 1))],
      now: NOW,
    }).payload;
    const bigRows = many('B', MAX_NOTES);
    const { payload } = buildPayload({
      previous: first,
      releases: [...smallRows, ...bigRows],
      sources: [fakeSource(small, smallRows), fakeSource(big, bigRows)],
      now: LATER,
    });
    assert.equal(payload.sources.big.status, 'failed');
    assert.equal(payload.sources.big.checkedAt, NOW);
    assert.equal(payload.releases.B0.status, 'listed');
    assert.equal(payload.releases.B0.checkedAt, NOW);
    assert.ok('https://big.example/B0' in payload.notes);
    assert.equal(payload.releases.S0.checkedAt, LATER);
    assert.equal(payload.sources.small.status, 'ok');
  });

  it('charges the overflow to the later source whichever one is big', () => {
    const bigRows = many('B', MAX_NOTES);
    const { payload } = buildPayload({
      previous: null,
      releases: [...bigRows, ...smallRows],
      sources: [fakeSource(big, bigRows), fakeSource(small, smallRows)],
      now: NOW,
    });
    assert.equal(payload.sources.big.status, 'ok');
    assert.equal(payload.sources.small.status, 'failed');
    assert.equal(Object.keys(payload.notes).length, MAX_NOTES);
  });

  it('writes both sources when together they fit', () => {
    const bigRows = many('B', MAX_NOTES - 1);
    const { payload } = buildPayload({
      previous: null,
      releases: [...smallRows, ...bigRows],
      sources: [fakeSource(small, smallRows), fakeSource(big, bigRows)],
      now: NOW,
    });
    assert.equal(payload.sources.big.status, 'ok');
    assert.equal(Object.keys(payload.notes).length, MAX_NOTES);
  });
});

describe('payloadProblems', () => {
  const entry = (status, extra = {}) => ({
    status, notes: [], cves: [], count: null, patchLevel: null, checkedAt: NOW, ...extra,
  });
  const A = 'https://x.example/a';
  const B = 'https://x.example/b';
  const note = (...ids) => ({
    source: 'src',
    title: 't',
    published: null,
    cves: ids.map((id) => ({ id, severity: null })),
    noCveEntries: false,
  });
  const valid = () => ({
    schema: 1,
    generatedAt: NOW,
    sources: { src: { status: 'ok', checkedAt: NOW, index: 'https://x.example/' } },
    notes: { [A]: note('CVE-2026-0001') },
    releases: {
      a: entry('listed', { notes: [A], cves: ['CVE-2026-0001'], count: 1 }),
      b: entry('no-cve-entries', { count: 0 }),
      c: entry('not-found'),
      d: entry('not-applicable'),
      e: entry('unavailable'),
      f: entry('not-connected'),
    },
  });
  const withRelease = (key, value) => ({ ...valid(), releases: { [key]: value } });
  const withNotes = (notes) => ({ ...valid(), notes });
  const refuses = (payload, text) => {
    const found = payloadProblems(payload);
    assert.ok(found.some((line) => line.includes(text)), `${text} in ${JSON.stringify(found)}`);
  };

  it('accepts what the builder writes', () => {
    assert.deepEqual(payloadProblems(valid()), []);
    const { payload } = build([appleSource(), androidSource()]);
    assert.deepEqual(payloadProblems(payload), []);
  });

  it('refuses a bad header', () => {
    assert.notDeepEqual(payloadProblems(null), []);
    assert.notDeepEqual(payloadProblems({ ...valid(), schema: 2 }), []);
    assert.notDeepEqual(payloadProblems({ ...valid(), generatedAt: 'soon' }), []);
    assert.notDeepEqual(payloadProblems({ ...valid(), generatedAt: 5 }), []);
    for (const key of ['sources', 'notes', 'releases']) {
      assert.notDeepEqual(payloadProblems({ ...valid(), [key]: [] }), [], key);
      assert.notDeepEqual(payloadProblems({ ...valid(), [key]: null }), [], key);
    }
  });

  it('refuses a status the builder does not emit', () => {
    for (const status of ['linked', 'ok', undefined]) {
      assert.notDeepEqual(payloadProblems(withRelease('x', entry(status))), [], String(status));
    }
    assert.notDeepEqual(payloadProblems(withRelease('x', 'listed')), []);
  });

  it('refuses a wrong shape for each status', () => {
    const note = ['https://x.example/a'];
    const cve = ['CVE-2026-0001'];
    const bad = [
      entry('listed', { notes: note, cves: cve, count: 2 }),
      entry('listed', { notes: note, cves: [], count: 0 }),
      entry('listed', { notes: [], cves: cve, count: 1 }),
      entry('listed', { notes: note, cves: cve, count: null }),
      entry('no-cve-entries', { count: null }),
      entry('no-cve-entries', { count: 1 }),
      entry('no-cve-entries', { count: 0, cves: cve }),
      entry('not-found', { count: 0 }),
      entry('not-found', { notes: note }),
      entry('unavailable', { cves: cve }),
      entry('not-applicable', { count: 1 }),
      entry('not-connected', { notes: note }),
      { ...entry('unavailable'), notes: null },
    ];
    for (const value of bad) {
      assert.notDeepEqual(payloadProblems(withRelease('x', value)), [], JSON.stringify(value));
    }
  });

  it('accepts a release that draws its CVEs from several notes', () => {
    const payload = {
      ...valid(),
      notes: { [A]: note('CVE-2026-0001'), [B]: note('CVE-2026-0002', 'CVE-2026-0003') },
      releases: {
        x: entry('listed', {
          notes: [A, B],
          cves: ['CVE-2026-0001', 'CVE-2026-0002', 'CVE-2026-0003'],
          count: 3,
        }),
      },
    };
    assert.deepEqual(payloadProblems(payload), []);
  });

  it('refuses a bad notes map', () => {
    const extra = (key) => withNotes({ ...valid().notes, [key]: note('CVE-2026-0001') });
    refuses(extra('http://x.example/a'), 'not https');
    refuses(extra('https://'), 'not https');
    for (const value of ['text', null, [], 5]) {
      refuses(withNotes({ [A]: value }), 'is not an object');
    }
    for (const source of ['other', 'toString', undefined, 5]) {
      refuses(withNotes({ [A]: { ...note('CVE-2026-0001'), source } }), 'names an unknown source');
    }
    const badCves = [
      [{ id: 'CVE-26-1' }],
      [{ id: 'CVE-2026-001' }],
      [{ id: 'cve-2026-0001' }],
      [{ id: 5 }],
      [{}],
      [null],
      'CVE-2026-0001',
      undefined,
    ];
    for (const cves of badCves) {
      refuses(withNotes({ [A]: { ...note(), cves } }), 'has a bad CVE');
    }
  });

  it('refuses note CVEs that are not sorted and unique', () => {
    const wrong = [
      note('CVE-2026-0002', 'CVE-2026-0001'),
      note('CVE-2026-0001', 'CVE-2026-0001'),
      note('CVE-2026-0010', 'CVE-2026-0009', 'CVE-2026-0011'),
    ];
    for (const value of wrong) {
      refuses(withNotes({ [A]: value }), 'cves are not sorted and unique');
    }
  });

  it('refuses a release note that is missing or not https', () => {
    const missing = entry('listed', { notes: [B], cves: ['CVE-2026-0001'], count: 1 });
    refuses(withRelease('x', missing), `names a note that is missing: ${B}`);
    const plain = entry('listed', { notes: ['http://x.example/a'], cves: [], count: 1 });
    refuses({ ...withRelease('x', plain), notes: { 'http://x.example/a': note() } }, 'not https');
    refuses(withRelease('x', entry('listed', { notes: [null], cves: [], count: 1 })), 'not https');
    const proto = entry('listed', { notes: ['__proto__'], cves: [], count: 1 });
    refuses(withRelease('x', proto), 'names a note that is missing');
  });

  it('refuses release notes that are not sorted and unique', () => {
    const both = { ...valid().notes, [B]: note('CVE-2026-0002') };
    const cves = ['CVE-2026-0001', 'CVE-2026-0002'];
    for (const notes of [[B, A], [A, A]]) {
      const release = withRelease('x', entry('listed', { notes, cves, count: 2 }));
      refuses({ ...release, notes: both }, 'notes are not sorted and unique');
    }
  });

  it('refuses a release CVE that is malformed, unsorted or not in its notes', () => {
    const both = { [A]: note('CVE-2026-0001', 'CVE-2026-0002') };
    const listed = (cves) => ({
      ...withRelease('x', entry('listed', { notes: [A], cves, count: cves.length })),
      notes: both,
    });
    refuses(listed(['CVE-26-1']), 'has a bad CVE');
    refuses(listed([5]), 'has a bad CVE');
    refuses(listed(['CVE-2026-0009']), 'lists CVE-2026-0009 that its notes do not');
    refuses(listed(['CVE-2026-0002', 'CVE-2026-0001']), 'cves are not sorted and unique');
    refuses(listed(['CVE-2026-0001', 'CVE-2026-0001']), 'cves are not sorted and unique');
    assert.deepEqual(payloadProblems(listed(['CVE-2026-0001', 'CVE-2026-0002'])), []);
  });

  it('refuses a CVE that only a note the release does not name lists', () => {
    const payload = {
      ...valid(),
      notes: { [A]: note('CVE-2026-0001'), [B]: note('CVE-2026-0002') },
      releases: { x: entry('listed', { notes: [A], cves: ['CVE-2026-0002'], count: 1 }) },
    };
    refuses(payload, 'lists CVE-2026-0002 that its notes do not');
  });

  it('refuses a listed release that omits a CVE its notes list', () => {
    const payload = {
      ...valid(),
      notes: { [A]: note('CVE-2026-0001', 'CVE-2026-0002') },
      releases: { x: entry('listed', { notes: [A], cves: ['CVE-2026-0001'], count: 1 }) },
    };
    refuses(payload, 'x omits 1 cves its notes list');
  });
});
