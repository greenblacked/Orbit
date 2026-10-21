// The Apple security-notes adapter and the payload built from it, on the recorded fixtures.
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPayload, MAX_CVES_PER_NOTE, MAX_NOTES, neededPages } from '../deploy/security/build.js';
import apple, {
  covers,
  decode,
  isNoteUrl,
  match,
  parseIndex,
  parseNote,
  parseProducts,
  parsePublished,
  parseRowDate,
} from '../deploy/security/apple.js';
import { isSecuritySource, SECURITY_SOURCES } from '../deploy/security/index.js';
import { payloadProblems } from '../deploy/security/validate.js';
import { problems } from './support/security_contract.mjs';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/apple-security/${name}`, import.meta.url)), 'utf8');
const INDEX = fixture('releases-index-slice.html');
const NOTE = fixture('note-149226-slice-1.html');
const PUBLISHED = fixture('note-149226-slice-2.html');

const NOTE_URL = 'https://support.apple.com/en-us/149226';
const NOW = '2026-10-12T10:00:00Z';

describe('parseIndex on the recorded index slice', () => {
  const rows = parseIndex(INDEX);
  const named = (name) => rows.filter((row) => row.name === name);

  it('keeps the Apple OS rows and drops the cut row, Safari, Xcode and firmware', () => {
    assert.equal(rows.length, 50);
    assert.ok(!rows.some((row) => /^(Safari|Xcode|Beats)/.test(row.name)));
    assert.equal(named('iOS 18.7.7 and iPadOS 18.7.7').length, 0);
    assert.equal(rows.at(-1).name, 'iOS 26.4.1 and iPadOS 26.4.1');
  });

  it('reads a row with a link', () => {
    assert.deepEqual(named('iOS 26.7.1 and iPadOS 26.7.1'), [
      {
        name: 'iOS 26.7.1 and iPadOS 26.7.1',
        products: [
          { family: 'iOS', version: '26.7.1' },
          { family: 'iPadOS', version: '26.7.1' },
        ],
        note: NOTE_URL,
        noCveEntries: false,
        date: '2026-09-28',
      },
    ]);
  });

  it('reads a row that says it has no CVE entries and links nowhere', () => {
    assert.deepEqual(rows[0], {
      name: 'iOS 27.0.1 and iPadOS 27.0.1',
      products: [
        { family: 'iOS', version: '27.0.1' },
        { family: 'iPadOS', version: '27.0.1' },
      ],
      note: null,
      noCveEntries: true,
      date: '2026-09-28',
    });
    assert.equal(rows.filter((row) => row.noCveEntries).length, 10);
    assert.ok(rows.every((row) => row.noCveEntries === (row.note === null)));
  });

  it('keeps both rows of a name the vendor lists twice', () => {
    assert.deepEqual(
      named('watchOS 27.0.1').map((row) => row.date),
      ['2026-09-28', '2026-09-23'],
    );
  });

  it('maps a macOS code name to the family and the version number', () => {
    assert.deepEqual(named('macOS Golden Gate 27.0.1')[0].products, [
      { family: 'macOS', version: '27.0.1' },
    ]);
    assert.deepEqual(named('macOS Tahoe 26.7.1')[0].products, [{ family: 'macOS', version: '26.7.1' }]);
  });

  it('accepts only https notes on support.apple.com', () => {
    for (const row of rows) {
      if (row.note !== null) assert.match(row.note, /^https:\/\/support\.apple\.com\/en-us\/\d+$/);
    }
    const cell = (name, href) =>
      `<tr><td><p><a href="${href}">${name}</a></p></td><td><p>x</p></td><td><p>28 Sep 2026</p></td></tr>`;
    for (const href of [
      'http://support.apple.com/en-us/1',
      'https://example.com/en-us/1',
      'https://support.apple.com.evil.example/1',
      'https://user@support.apple.com/1',
      'https://support.apple.com:8443/1',
      'javascript:alert(1)',
    ]) {
      assert.deepEqual(parseIndex(cell('iOS 26.7.1', href)), [], href);
    }
    assert.equal(parseIndex(cell('iOS 26.7.1', 'https://support.apple.com/en-us/1')).length, 1);
  });

  it('resolves a relative link against the index and refuses a query or fragment', () => {
    const cell = (href) =>
      `<tr><td><p><a href="${href}">iOS 26.7.1</a></p></td><td><p>x</p></td><td><p>28 Sep 2026</p></td></tr>`;
    assert.equal(parseIndex(cell('/en-us/149226'))[0].note, NOTE_URL);
    for (const href of ['/en-us/149226#x', '/en-us/149226?a=1', '/other/1', '/en-us/abc']) {
      assert.deepEqual(parseIndex(cell(href)), [], href);
    }
    assert.equal(isNoteUrl(`${NOTE_URL}#x`), false);
    assert.equal(isNoteUrl(NOTE_URL), true);
  });

  it('drops a row without a valid date, a product, a link or a closing tag', () => {
    const row = (name, date) =>
      `<tr><td><p><a href="${NOTE_URL}">${name}</a></p></td><td><p>x</p></td><td><p>${date}</p></td></tr>`;
    assert.equal(parseIndex(row('iOS 26.7.1', '28 Sep 2026')).length, 1);
    assert.equal(parseIndex(row('iOS 26.7.1', '31 Feb 2026')).length, 0);
    assert.equal(parseIndex(row('iOS 26.7.1', 'soon')).length, 0);
    assert.equal(parseIndex(row('Safari 26.7', '28 Sep 2026')).length, 0);
    assert.equal(parseIndex(row('iOS 26.7.1', '28 Sep 2026').replace('</tr>', '')).length, 0);
    const bare = '<tr><td><p>iOS 26.7.1</p></td><td><p>x</p></td><td><p>28 Sep 2026</p></td></tr>';
    assert.equal(parseIndex(bare).length, 0);
    assert.deepEqual(parseIndex(''), []);
    assert.deepEqual(parseIndex(null), []);
  });
});

describe('the small parsers', () => {
  it('splits and filters product names by family and version', () => {
    assert.deepEqual(parseProducts('iOS 26.7.1 and iPadOS 26.7.1'), [
      { family: 'iOS', version: '26.7.1' },
      { family: 'iPadOS', version: '26.7.1' },
    ]);
    assert.deepEqual(parseProducts('macOS Sequoia 15.8.1'), [{ family: 'macOS', version: '15.8.1' }]);
    assert.deepEqual(parseProducts('visionOS 27'), [{ family: 'visionOS', version: '27' }]);
    assert.deepEqual(parseProducts('tvOS 26.6'), [{ family: 'tvOS', version: '26.6' }]);
    const ignored = ['Safari 27', 'Xcode 27', 'Beats Firmware Update 1B211', 'iOS Golden 27', 'macOS Tahoe'];
    for (const name of ignored) assert.deepEqual(parseProducts(name), [], name);
  });

  it('parses a row date and refuses a day that does not exist', () => {
    assert.equal(parseRowDate('28 Sep 2026'), '2026-09-28');
    assert.equal(parseRowDate('09 Apr 2026'), '2026-04-09');
    assert.equal(parseRowDate('30 Feb 2026'), null);
    assert.equal(parseRowDate('28 Sept 2026'), null);
  });

  it('decodes the references the pages use and leaves others alone', () => {
    const text = decode('Name&nbsp;and&nbsp;link &amp; more &#39;x&#x27; &unknown; &#0;');
    assert.equal(text, "Name and link & more 'x' &unknown; &#0;");
  });
});

describe('parseNote on the recorded note slices', () => {
  it('reads the title, products, release date and CVE ids', () => {
    assert.deepEqual(parseNote(NOTE), {
      title: 'iOS 26.7.1 and iPadOS 26.7.1',
      products: [
        { family: 'iOS', version: '26.7.1' },
        { family: 'iPadOS', version: '26.7.1' },
      ],
      released: '2026-09-28',
      cves: ['CVE-2026-86950'],
    });
  });

  it('keeps no impact or description text', () => {
    const text = JSON.stringify(parseNote(NOTE));
    for (const word of ['out-of-bounds', 'arbitrary code', 'Meta Product Security']) {
      assert.ok(!text.includes(word), word);
    }
  });

  it('reads the Published Date although its dateTime attribute is malformed', () => {
    assert.match(PUBLISHED, /dateTime=September 28, 2026itemprop/);
    assert.equal(parsePublished(PUBLISHED), '2026-09-28');
    assert.equal(parsePublished(NOTE), '2026-09-28');
    assert.equal(parseNote(PUBLISHED), null);
  });

  it('counts only ids that start a credit paragraph', () => {
    const page = [
      '<h1>About the security content of macOS Tahoe 26.7.1</h1>',
      '<p class="gb-paragraph">Description: fixes CVE-2026-1111 in passing.</p>',
      '<p class="gb-paragraph">CVE-2026-0002, CVE-2026-0001: A. Researcher</p>',
      '<p class="gb-paragraph">CVE-2026-0002: B. Researcher</p>',
      '<p class="gb-paragraph">CVE-26-1: not an id</p>',
    ].join('\n');
    assert.deepEqual(parseNote(page).cves, ['CVE-2026-0001', 'CVE-2026-0002']);
    assert.equal(parseNote(page).released, null);
  });
});

describe('match', () => {
  const rows = parseIndex(INDEX);
  const release = (id, family, version, date, stage = 'release') => ({
    id,
    vendor: 'apple',
    family,
    version,
    stage,
    date,
    title: `${family} ${version}`,
  });
  const releases = [
    release('ios', 'iOS', '26.7.1', '2026-09-28T17:00:00Z'),
    release('ipados', 'iPadOS', '26.7.1', '2026-09-28T17:00:00Z'),
    release('mac', 'macOS', '27.0.1', '2026-09-28T20:00:00Z'),
    release('beta', 'iOS', '27.2', '2026-10-05T18:00:00Z', 'beta'),
    release('rc', 'iOS', '27.2', '2026-10-05T18:00:00Z', 'rc'),
    release('old', 'iOS', '25.0', '2026-01-01T00:00:00Z'),
    release('late', 'iOS', '26.7.1', '2026-09-20T17:00:00Z'),
    release('watch-new', 'watchOS', '27.0.1', '2026-09-28T20:00:00Z'),
    release('watch-old', 'watchOS', '27.0.1', '2026-09-23T10:00:00Z'),
    { ...release('other', 'Android', '17', '2026-09-28T00:00:00Z'), vendor: 'google' },
  ];
  const found = new Map(match(releases, rows).map((item) => [item.id, item]));

  it('matches a release to the row of its family, version number and date', () => {
    assert.equal(found.get('ios').status, 'matched');
    assert.equal(found.get('ios').row.note, NOTE_URL);
    assert.equal(found.get('ipados').row.note, NOTE_URL);
    assert.equal(found.get('mac').row.name, 'macOS Golden Gate 27.0.1');
    assert.equal(found.get('mac').row.noCveEntries, true);
  });

  it('prefers the row nearest in date when a version is listed twice', () => {
    assert.equal(found.get('watch-new').row.date, '2026-09-28');
    assert.equal(found.get('watch-old').row.date, '2026-09-23');
  });

  it('marks a beta or release candidate not-applicable', () => {
    assert.deepEqual([found.get('beta').status, found.get('rc').status], ['not-applicable', 'not-applicable']);
    assert.equal(found.get('beta').row, null);
  });

  it('marks a release with no row, or a row far in date, not-found', () => {
    assert.equal(found.get('old').status, 'not-found');
    assert.equal(found.get('late').status, 'not-found');
  });

  it('describes only the vendor\'s own releases', () => {
    assert.equal(found.has('other'), false);
    assert.equal(found.size, releases.length - 1);
  });

  it('matches a release the feed dates days before the index does', () => {
    const rowsFor = parseIndex(
      '<tr><td><p><a href="https://support.apple.com/en-us/1">iOS 26.7 and iPadOS 26.7</a></p></td>' +
        '<td><p>x</p></td><td><p>14 Sep 2026</p></td></tr>',
    );
    const [item] = match([release('pad', 'iPadOS', '26.7', '2026-09-09T10:00:00Z')], rowsFor);
    assert.equal(item.status, 'matched');
  });

  it('refuses a row exactly 7 days from the release and accepts one 6 days away', () => {
    const rowsFor = parseIndex(
      '<tr><td><p><a href="https://support.apple.com/en-us/1">iOS 26.7 and iPadOS 26.7</a></p></td>' +
        '<td><p>x</p></td><td><p>14 Sep 2026</p></td></tr>',
    );
    const status = (date) => match([release('pad', 'iPadOS', '26.7', date)], rowsFor)[0].status;
    assert.equal(status('2026-09-07T23:59:00Z'), 'not-found', '7 days, late in the day');
    assert.equal(status('2026-09-07T00:00:00Z'), 'not-found', '7 days, start of the day');
    assert.equal(status('2026-09-21T10:00:00Z'), 'not-found', '7 days after the row');
    assert.equal(status('2026-09-08T23:59:00Z'), 'matched', '6 days');
    assert.equal(status('2026-09-20T00:00:00Z'), 'matched', '6 days after the row');
  });

  it('treats 27.0 and 27 as one version', () => {
    const [item] = match([release('x', 'iOS', '27.0', '2026-09-14T17:00:00Z')], parseIndex(INDEX));
    assert.equal(item.status, 'matched');
    assert.equal(item.row.name, 'iOS 27 and iPadOS 27');
  });
});

describe('buildPayload', () => {
  const rows = parseIndex(INDEX);
  const row = (id, family, version, stage, date, vendor = 'apple') => ({
    id,
    vendor,
    family,
    version,
    stage,
    date,
    title: `${family} ${version}`,
  });
  const releases = [
    row('ios', 'iOS', '26.7.1', 'release', '2026-09-28T17:00:00Z'),
    row('ipad', 'iPadOS', '26.7.1', 'release', '2026-09-28T17:00:00Z'),
    row('mac', 'macOS', '27.0.1', 'release', '2026-09-28T20:00:00Z'),
    row('beta', 'iOS', '27.2', 'beta', '2026-10-05T18:00:00Z'),
    row('old', 'iOS', '25.0', 'release', '2026-01-01T00:00:00Z'),
    row('pixel', 'Android', '17', 'release', '2026-09-28T00:00:00Z', 'google'),
  ];
  const build = (extra = {}) =>
    buildPayload({
      previous: null,
      releases,
      sources: [{ adapter: apple, rows, pages: new Map([[NOTE_URL, NOTE]]) }],
      now: NOW,
      ...extra,
    });

  it('asks for each needed page once', () => {
    assert.deepEqual(neededPages(apple, releases, rows), [NOTE_URL]);
    assert.deepEqual(neededPages(apple, releases, rows, 0), []);
  });

  it('builds a payload that passes the contract', () => {
    const { payload, failures } = build();
    assert.deepEqual(failures, []);
    assert.deepEqual(problems(payload, releases), []);
    assert.deepEqual(Object.keys(payload), ['schema', 'generatedAt', 'sources', 'notes', 'releases']);
  });

  it('writes the source, the note and a row per status', () => {
    const { payload } = build();
    assert.deepEqual(payload.sources, {
      'apple-security-releases': {
        status: 'ok',
        checkedAt: NOW,
        index: 'https://support.apple.com/en-us/100100',
      },
    });
    assert.deepEqual(payload.notes, {
      [NOTE_URL]: {
        source: 'apple-security-releases',
        title: 'iOS 26.7.1 and iPadOS 26.7.1',
        published: '2026-09-28',
        cves: [{ id: 'CVE-2026-86950', severity: null }],
        noCveEntries: false,
      },
    });
    const status = (id) => payload.releases[id];
    assert.deepEqual(status('ios'), {
      status: 'listed',
      notes: [NOTE_URL],
      cves: ['CVE-2026-86950'],
      count: 1,
      patchLevel: null,
      checkedAt: NOW,
      source: 'apple-security-releases',
    });
    assert.equal(status('ipad').status, 'listed');
    assert.deepEqual([status('mac').status, status('mac').count], ['no-cve-entries', 0]);
    assert.equal(status('beta').status, 'not-applicable');
    assert.equal(status('old').status, 'not-found');
    assert.equal(status('old').count, null);
    assert.equal(payload.releases.pixel.status, 'not-connected');
    assert.equal('source' in payload.releases.pixel, false);
  });

  it('is stable: the same input gives the same bytes, with sorted keys', () => {
    const first = JSON.stringify(build().payload);
    assert.equal(JSON.stringify(build().payload), first);
    const { releases: keyed } = build().payload;
    assert.deepEqual(Object.keys(keyed), Object.keys(keyed).sort());
  });

  it('marks a release unavailable, not zero, when its page was not read', () => {
    const { payload, failures } = build({
      sources: [{ adapter: apple, rows, pages: new Map() }],
    });
    assert.equal(payload.releases.ios.status, 'unavailable');
    assert.equal(payload.releases.ios.count, null);
    assert.deepEqual(payload.notes, {});
    assert.equal(failures.length, 2);
    assert.deepEqual(problems(payload, releases), []);
  });

  it('keeps the previous note when the page cannot be read again', () => {
    const { payload: before } = build();
    const { payload, failures } = build({
      previous: before,
      now: '2026-10-13T10:00:00Z',
      sources: [{ adapter: apple, rows, pages: new Map() }],
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /was not read again/);
    assert.equal(payload.releases.ios.status, 'listed');
    assert.equal(payload.releases.ios.checkedAt, NOW);
    assert.deepEqual(payload.notes, before.notes);
    assert.deepEqual(problems(payload, releases), []);
  });

  it('refuses a page that is not the release\'s security content', () => {
    const other = NOTE.replace(/iOS 26\.7\.1 and iPadOS 26\.7\.1/g, 'macOS Tahoe 26.7.1');
    const { payload } = build({ sources: [{ adapter: apple, rows, pages: new Map([[NOTE_URL, other]]) }] });
    assert.equal(payload.releases.ios.status, 'unavailable');
  });

  it('does not fall back to the previous note when a page was read and refused', () => {
    const { payload: before } = build();
    const unnamed = NOTE.replace(/iOS 26\.7\.1 and iPadOS 26\.7\.1/g, 'Security updates');
    const wrong = NOTE.replace(/iOS 26\.7\.1 and iPadOS 26\.7\.1/g, 'macOS Tahoe 26.7.1');
    const noCve = NOTE.replace(/CVE-\d{4}-\d{4,}/g, 'none');
    for (const html of [unnamed, wrong, noCve]) {
      const { payload, failures } = build({
        previous: before,
        sources: [{ adapter: apple, rows, pages: new Map([[NOTE_URL, html]]) }],
      });
      assert.equal(payload.releases.ios.status, 'unavailable');
      assert.ok(failures.length > 0);
    }
  });

  it('keeps a listed release and reports it when its row stops matching', () => {
    const { payload: before } = build();
    const { payload, failures } = build({
      previous: before,
      sources: [{ adapter: apple, rows: rows.filter((r) => r.note !== NOTE_URL), pages: new Map() }],
    });
    assert.deepEqual(payload.releases.ios, before.releases.ios);
    assert.ok(failures.some((failure) => /no longer matches/.test(failure)));
    // The kept row still names its note, so the note is kept too and the payload is valid.
    assert.deepEqual(payload.notes, before.notes);
    assert.deepEqual(payloadProblems(payload), []);
  });

  it('lists a kept row\'s full notes when a shared note is read again with another CVE', () => {
    const { payload: before } = build();
    const more = `${NOTE}<p class="gb-paragraph">CVE-2026-86951: Test credit</p>`;
    // The iPadOS release still matches; the iOS one no longer does (its row names iPadOS only).
    const drifted = rows.map((r) =>
      r.note === NOTE_URL ? { ...r, products: r.products.filter((p) => p.family === 'iPadOS') } : r,
    );
    const { payload, failures } = build({
      previous: before,
      now: '2026-10-13T10:00:00Z',
      sources: [{ adapter: apple, rows: drifted, pages: new Map([[NOTE_URL, more]]) }],
    });
    assert.ok(failures.some((failure) => /iOS 26\.7\.1 was listed and no longer matches/.test(failure)));
    const union = ['CVE-2026-86950', 'CVE-2026-86951'];
    assert.deepEqual(payload.notes[NOTE_URL].cves.map((cve) => cve.id), union);
    for (const id of ['ios', 'ipad']) {
      assert.deepEqual(payload.releases[id].cves, union, id);
      assert.equal(payload.releases[id].count, 2, id);
    }
    // The kept row keeps its time; only its list is brought in line with the note.
    assert.equal(payload.releases.ios.checkedAt, NOW);
    assert.equal(payload.releases.ipad.checkedAt, '2026-10-13T10:00:00Z');
    assert.deepEqual(payloadProblems(payload), []);
    assert.deepEqual(problems(payload, releases), []);
  });

  it('refuses a page with more CVEs than the cap', () => {
    const many = Array.from(
      { length: MAX_CVES_PER_NOTE + 1 },
      (_, i) => `<p>CVE-2026-${String(10000 + i)}: credit</p>`,
    ).join('');
    const pages = new Map([[NOTE_URL, NOTE + many]]);
    const { payload, failures } = build({ sources: [{ adapter: apple, rows, pages }] });
    assert.equal(payload.releases.ios.status, 'unavailable');
    assert.ok(failures.length > 0);
  });

  it('throws over the byte cap and fails a source over the note cap', () => {
    assert.throws(() => build({ maxBytes: 100 }), /over 100/);
    const fake = {
      id: 'fake',
      vendor: 'fake',
      index: 'https://example.com/',
      parseNote: () => ({ title: 't', products: [], released: null, cves: ['CVE-2026-0001'] }),
      match: (list) =>
        list.map((r) => ({
          id: r.id,
          status: 'matched',
          row: { note: `https://example.com/${r.id}`, noCveEntries: false },
        })),
    };
    const many = Array.from({ length: MAX_NOTES + 1 }, (_, i) =>
      row(`r${i}`, 'X', '1', 'release', '2026-09-28T00:00:00Z', 'fake'),
    );
    const pages = new Map(many.map((r) => [`https://example.com/${r.id}`, '<h1>t</h1>']));
    const { payload, failures } = buildPayload({
      previous: null,
      releases: many,
      sources: [{ adapter: fake, rows: [{}], pages }],
      now: NOW,
    });
    assert.equal(payload.sources.fake.status, 'failed');
    assert.deepEqual(Object.keys(payload.notes), []);
    assert.ok(failures.some((line) => line.includes('cap of 400')));
  });

  it('fails closed per source: keeps the old data, marks it failed, reports it', () => {
    const { payload: before } = build();
    for (const bad of [null, []]) {
      const { payload, failures } = build({
        previous: before,
        now: '2026-10-13T10:00:00Z',
        sources: [{ adapter: apple, rows: bad, pages: new Map() }],
      });
      assert.equal(failures.length, 1);
      assert.deepEqual(payload.sources['apple-security-releases'], {
        status: 'failed',
        checkedAt: NOW,
        index: 'https://support.apple.com/en-us/100100',
      });
      assert.deepEqual(payload.notes, before.notes);
      assert.deepEqual(payload.releases.ios, before.releases.ios);
      assert.equal(payload.generatedAt, '2026-10-13T10:00:00Z');
      assert.deepEqual(problems(payload, releases), []);
    }
  });

  it('marks a release never covered unavailable when the first run fails', () => {
    const { payload } = build({ sources: [{ adapter: apple, rows: null, pages: new Map() }] });
    assert.equal(payload.sources['apple-security-releases'].status, 'failed');
    assert.equal(payload.releases.ios.status, 'unavailable');
    assert.equal(payload.releases.beta.status, 'not-applicable');
    assert.deepEqual(problems(payload, releases), []);
  });

  it('drops the rows of releases that left releases.json', () => {
    const { payload: before } = build();
    const { payload } = build({ previous: before, releases: releases.filter((r) => r.id !== 'ios') });
    assert.equal('ios' in payload.releases, false);
    assert.equal(payload.releases.ipad.status, 'listed');
  });
});

describe('covers', () => {
  const page = { products: [{ family: 'iOS', version: '27.0' }] };
  it('needs a recognised product of the release\'s own family and version', () => {
    assert.equal(covers(page, { family: 'iOS', version: '27' }), true);
    assert.equal(covers(page, { family: 'iOS', version: '27.0.1' }), false);
    assert.equal(covers(page, { family: 'macOS', version: '27' }), false);
    assert.equal(covers({ products: [] }, { family: 'iOS', version: '27' }), false);
    assert.equal(covers(null, { family: 'iOS', version: '27' }), false);
  });
});

describe('the registry', () => {
  it('holds Apple, with distinct ids and the shape the snapshot script relies on', () => {
    assert.ok(SECURITY_SOURCES.includes(apple));
    assert.equal(new Set(SECURITY_SOURCES.map((source) => source.id)).size, SECURITY_SOURCES.length);
    for (const source of SECURITY_SOURCES) assert.equal(isSecuritySource(source), true, source.id);
    assert.equal(isSecuritySource({ ...apple, index: 'http://support.apple.com/' }), false);
    assert.equal(isSecuritySource({ ...apple, hosts: [] }), false);
    assert.equal(isSecuritySource(null), false);
  });
});
