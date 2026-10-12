// Tests for the Android adapter: the AOSP build-numbers page and its HTML table scanner.
// The fixture is an excerpt of the page as recorded by the read-only probe of 2026-10-12; the
// inputs built inside the tests are synthetic and say so.
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isHttpsOn } from '../deploy/releases.js';
import android, {
  buildDate,
  buildTable,
  FAMILIES,
  HOST,
  ID,
  MAX_CELLS,
  MAX_INPUT,
  MAX_ROWS,
  PAGE_URL,
  parsePage,
  parseRow,
  tables,
  VENDOR,
} from '../deploy/sources/android.js';
import { isSource } from '../deploy/sources/index.js';
import { createWorker } from '../deploy/worker.js';
import {
  fakeCtx,
  fakeEnv,
  ORIGIN,
  state,
  stubUpstream,
  useHarness,
} from './support/harness.mjs';

const PAGE = readFileSync(
  fileURLToPath(new URL('./fixtures/google/build-numbers.html', import.meta.url)),
  'utf8',
);

const HEAD =
  '<tr><th><p id="build">Build ID</p></th><th>Tag</th><th>Version</th>' +
  '<th>Supported devices</th><th>Security patch level</th></tr>';
// A synthetic row: build id, tag, patch level.
const row = (build, tag, patch = '2026-06-05') =>
  `<tr><td>${build}</td><td>${tag}</td><td>Android17</td><td></td><td>${patch}</td></tr>`;
const page = (...rows) => `<table>${HEAD}${rows.join('')}</table>`;
const keys = [
  'beta', 'build', 'date', 'family', 'id', 'major', 'source', 'stage', 'title', 'url',
  'vendor', 'version',
];

useHarness();

describe('the Android adapter', () => {
  it('has the adapter shape, with the build-numbers page as its only allowed URL', () => {
    assert.equal(android.id, 'android-build-numbers');
    assert.equal(ID, android.id);
    assert.equal(android.vendor, 'google');
    assert.equal(VENDOR, 'google');
    assert.deepEqual(android.urls, [PAGE_URL]);
    assert.equal(PAGE_URL, 'https://source.android.com/docs/setup/reference/build-numbers');
    assert.equal(android.parse, parsePage);
    assert.equal(isSource(android), true);
    assert.deepEqual(FAMILIES, ['Android']);
    assert.ok(isHttpsOn(PAGE_URL, HOST));
    assert.equal(HOST, 'source.android.com');
  });
});

describe('the table scanner', () => {
  it('reads the three tables of the recorded page as rows of cell text', () => {
    const found = tables(PAGE);
    assert.equal(found.length, 3);
    assert.deepEqual(found[0][0], [
      'Codename',
      'Version',
      'API level/NDK release',
      'CTS version',
      'Quarterly release name',
    ]);
    assert.deepEqual(found[0][1], ['Android17', '17', 'API level 37', '17', '26Q2']);
    assert.deepEqual(found[1][0], [
      'Build ID',
      'Tag',
      'Version',
      'Supported devices',
      'Security patch level',
    ]);
    assert.deepEqual(found[1][1], ['15848949', 'android-security-17.0.0_r1', 'Android17', '', '2026-05-05']);
    assert.deepEqual(found[1][2], [
      'CP2A.260605.016',
      'android-17.0.0_r1',
      'Android17',
      '',
      '2026-06-05',
    ]);
    assert.deepEqual(found[2][1], ['HRI39', 'android-3.0_r1', 'Earliest Honeycomb version']);
  });

  it('finds the build table by its header, not by its position', () => {
    const found = buildTable(PAGE);
    assert.equal(found.rows.length, 31);
    assert.deepEqual([found.build, found.tag, found.patch], [0, 1, 4]);
    const moved = `<table><tr><th>Tag</th><th>Security patch level</th><th>Build ID</th></tr>
      <tr><td>android-17.0.0_r1</td><td>2026-06-05</td><td>CP2A.260605.016</td></tr></table>`;
    const releases = parsePage(moved);
    assert.equal(releases.length, 1);
    assert.equal(releases[0].build, 'CP2A.260605.016');
    assert.equal(buildTable('<table><tr><th>Build</th><th>Tag</th><th>Notes</th></tr></table>'), null);
  });

  it('reads upper case tags, attributes, missing closing tags and nested markup in a cell', () => {
    const html =
      '<TABLE class="x"><TR><TD data-a="1">a <b>b</b>\n  c</TD><TD>d<TD>e</TR><TR><TH>f</TH></TABLE>';
    assert.deepEqual(tables(html), [[['a b c', 'd', 'e'], ['f']]]);
  });

  it('ignores comments, nested tables and a table that is never closed', () => {
    assert.deepEqual(tables('<!-- <table><tr><td>x</td></tr></table> --><p>hi</p>'), []);
    assert.deepEqual(
      tables('<table><tr><td>a<table><tr><td>inner</td></tr></table></td><td>b</td></tr></table>'),
      [[['ainner', 'b']]],
    );
    assert.deepEqual(tables('<table><tr><td>a</td></tr>'), []);
    assert.deepEqual(tables('<table><tr><td>a</td></tr></table><table><tr><td>b'), [[['a']]]);
    assert.deepEqual(tables('<tr><td>no table</td></tr>'), []);
    assert.deepEqual(tables('<table><td>no row</td></table>'), [[]]);
  });

  it('is bounded: input size, rows per table and cells per row', () => {
    assert.deepEqual(tables(`${'x'.repeat(MAX_INPUT)}<table><tr><td>a</td></tr></table>`), []);
    const rows = '<tr><td>a</td></tr>'.repeat(MAX_ROWS + 50);
    assert.equal(tables(`<table>${rows}</table>`)[0].length, MAX_ROWS);
    const cells = '<td>a</td>'.repeat(MAX_CELLS + 20);
    assert.equal(tables(`<table><tr>${cells}</tr></table>`)[0][0].length, MAX_CELLS);
  });

  it('stays linear on hostile markup', () => {
    const started = Date.now();
    tables('<table>'.repeat(150000));
    tables('<tr><td>'.repeat(100000));
    tables('<'.repeat(500000));
    tables('<!--'.repeat(100000));
    tables(`<table>${'<td '.repeat(200000)}`);
    assert.ok(Date.now() - started < 5000);
  });

  it('copes with input that is not a string', () => {
    for (const bad of [undefined, null, 0, {}, []]) {
      assert.deepEqual(tables(bad), [], String(bad));
    }
  });
});

describe('buildDate', () => {
  it('takes the day from the build id, else from the security patch level', () => {
    assert.equal(buildDate('CP2A.260605.016', '2026-05-05'), '2026-06-05T00:00:00Z');
    assert.equal(buildDate('BP2A.250605.031.A3', ''), '2025-06-05T00:00:00Z');
    assert.equal(buildDate('15848949', '2026-05-05'), '2026-05-05T00:00:00Z');
    // A build date that is not a day falls back to the patch level.
    assert.equal(buildDate('CP2A.261305.016', '2026-06-05'), '2026-06-05T00:00:00Z');
    assert.equal(buildDate('CP2A.260230.016', '2026-03-01'), '2026-03-01T00:00:00Z');
  });

  it('refuses a day that does not exist, and a date out of range', () => {
    for (const [build, patch] of [
      ['15848949', ''],
      ['15848949', '2026-02-30'],
      ['15848949', '2026-13-01'],
      ['15848949', '2026-6-5'],
      ['15848949', '1999-01-01'],
      ['CP2A.260230.016', '2026-00-00'],
      ['CP2A.000000.016', ''],
    ]) {
      assert.equal(buildDate(build, patch), null, `${build} ${patch}`);
    }
    assert.equal(buildDate('CP2A.270229.001', ''), null, '2027 has no 29 February');
    assert.equal(buildDate('CP2A.280229.001', ''), '2028-02-29T00:00:00Z');
  });
});

describe('parsePage on the recorded page', () => {
  const releases = parsePage(PAGE);
  const byId = (id) => releases.find((r) => r.id === id);

  it('keeps one release per AOSP release tag and skips the security refreshes', () => {
    assert.equal(releases.length, 22);
    assert.equal(releases.filter((r) => r.id.includes('security')).length, 0);
    assert.equal(new Set(releases.map((r) => r.id)).size, releases.length);
    assert.ok(releases.every((r) => /^android-\d+\.\d+\.\d+_r\d+$/.test(r.id)));
    assert.equal(byId('android-security-17.0.0_r1'), undefined);
    assert.equal(byId('android-security-16.0.0_r8'), undefined);
  });

  it('is newest first', () => {
    for (let i = 1; i < releases.length; i += 1) {
      assert.ok(releases[i - 1].date >= releases[i].date, `${i} is out of order`);
    }
    assert.equal(releases[0].id, 'android-17.0.0_r1');
  });

  it('parses the newest release in full', () => {
    assert.deepEqual(byId('android-17.0.0_r1'), {
      id: 'android-17.0.0_r1',
      vendor: 'google',
      family: 'Android',
      version: '17.0.0',
      major: 17,
      stage: 'release',
      beta: null,
      build: 'CP2A.260605.016',
      title: 'Android 17 (android-17.0.0_r1)',
      date: '2026-06-05T00:00:00Z',
      url: 'https://source.android.com/docs/setup/reference/build-numbers',
      source: 'android-build-numbers',
    });
  });

  it('reads the build shapes of the page, with a suffix or without', () => {
    assert.equal(byId('android-16.0.0_r2').build, 'BP2A.250605.031.A3');
    assert.equal(byId('android-16.0.0_r2').date, '2025-06-05T00:00:00Z');
    assert.equal(byId('android-15.0.0_r32').build, 'BP1A.250505.005');
    assert.equal(byId('android-15.0.0_r31').build, 'BD4A.250505.003');
    assert.equal(byId('android-15.0.0_r36').title, 'Android 15 (android-15.0.0_r36)');
    assert.equal(byId('android-15.0.0_r36').major, 15);
    assert.equal(byId('android-16.0.0_r4').version, '16.0.0');
  });

  it('takes the date from the build id even when the patch level differs', () => {
    // The page lists patch level 2025-01-05 for this build, whose id says 2024-09-25.
    assert.equal(byId('android-15.0.0_r24').build, 'BD4A.240925.111');
    assert.equal(byId('android-15.0.0_r24').date, '2024-09-25T00:00:00Z');
    assert.equal(byId('android-15.0.0_r25').date, '2025-04-05T00:00:00Z');
  });

  it('marks every row a final release: the page lists no pre-release', () => {
    assert.ok(releases.every((r) => r.stage === 'release' && r.beta === null));
  });

  it('gives every release the whole contract, a Google family and the page as its link', () => {
    for (const r of releases) {
      assert.deepEqual(Object.keys(r).sort(), keys, r.id);
      assert.equal(r.vendor, 'google');
      assert.equal(r.family, 'Android');
      assert.equal(r.source, ID);
      assert.equal(r.url, PAGE_URL);
      assert.ok(isHttpsOn(r.url, 'source.android.com'));
      assert.match(r.date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      assert.match(r.build, /^[A-Z][A-Z0-9]{3,4}\.\d{6}\.\d{3}(\.[A-Z0-9]{1,4})?$/);
    }
  });

  it('keeps no text of the page beyond the tag and the build id', () => {
    const text = JSON.stringify(releases);
    assert.doesNotMatch(text, /Pixel|Android17|Android16|Codename|Honeycomb/);
  });

  it('does not read the other tables of the page', () => {
    assert.equal(releases.some((r) => r.id.startsWith('android-3.')), false);
    assert.equal(releases.some((r) => r.build === 'HRI39'), false);
  });
});

describe('pre-release and unlisted tags', () => {
  it('skips what is not a release tag of the form android-<major>.<minor>.<patch>_r<N>', () => {
    const skipped = [
      'android-security-17.0.0_r1',
      'android-17.0.0_beta1',
      'android-17.0.0_r1-beta',
      'android-17.0.0_r1.1',
      'android-17.0_r1',
      'android-3.0_r1',
      'android-17.0.0',
      'ANDROID-17.0.0_r1',
      'android-017.0.0_r1',
      'android-17.0.0_r01',
      'android-1000.0.0_r1',
      'android-17.0.0_r1000',
      'x-android-17.0.0_r1',
      'android-q-beta-1',
      '',
    ];
    assert.deepEqual(parsePage(page(...skipped.map((tag) => row('CP2A.260605.016', tag)))), []);
  });

  it('marks a tag that is listed as a release, never as a beta or an RC', () => {
    const [r] = parsePage(page(row('CP2A.260605.016', 'android-17.0.0_r1')));
    assert.equal(r.stage, 'release');
    assert.equal(r.beta, null);
  });

  it('accepts a numeric build id on a release tag and dates it by the patch level', () => {
    const [r] = parsePage(page(row('12345678', 'android-14.0.0_r1', '2023-10-05')));
    assert.equal(r.build, '12345678');
    assert.equal(r.date, '2023-10-05T00:00:00Z');
    assert.equal(r.version, '14.0.0');
  });
});

describe('malformed and empty input', () => {
  it('returns nothing for an empty document or one without the build table', () => {
    for (const bad of [
      '',
      '   ',
      undefined,
      null,
      42,
      'not html at all',
      '<html><body><p>Moved</p></body></html>',
      '<table></table>',
      '<table><tr><td>android-17.0.0_r1</td></tr></table>',
      '<table><tr><th>Tag</th><th>Build ID</th></tr></table>',
      page().replace('Security patch level', 'Patch'),
    ]) {
      assert.deepEqual(parsePage(bad), [], String(bad));
    }
  });

  it('returns nothing for a table that is cut off before it closes', () => {
    assert.deepEqual(parsePage(page(row('CP2A.260605.016', 'android-17.0.0_r1')).slice(0, -8)), []);
  });

  it('skips a malformed row and keeps the good ones', () => {
    const good = row('CP2A.260605.016', 'android-17.0.0_r1');
    const releases = parsePage(
      page(
        row('CP2A.260605.016', 'android-17.0.0_r2', 'soon'), // the build id still dates it
        row('cp2a.260605.016', 'android-17.0.0_r3'),
        row('CP2A.261305.016', 'android-17.0.0_r4', 'never'),
        row('', 'android-17.0.0_r5', ''),
        row('CP2A.260605.016; DROP TABLE', 'android-17.0.0_r6'),
        row('CP2A.260605.016', 'android-17.0.0_r7&nbsp;'),
        '<tr><td>only one cell</td></tr>',
        '<tr></tr>',
        '<tr><td>CP2A.260605.016</td><td>android-17.0.0_r8</td></tr>',
        good,
      ),
    );
    assert.deepEqual(releases.map((r) => r.id), ['android-17.0.0_r1', 'android-17.0.0_r2']);
  });

  it('returns a row once when the page repeats it', () => {
    const good = row('CP2A.260605.016', 'android-17.0.0_r1');
    assert.equal(parsePage(page(good, good, good)).length, 1);
  });

  it('refuses a row that is missing a column it needs', () => {
    const cols = { build: 0, tag: 1, patch: 4 };
    assert.equal(parseRow(['CP2A.260605.016', 'android-17.0.0_r1'], cols), null);
    assert.equal(parseRow([], cols), null);
    assert.equal(parseRow(['CP2A.260605.016', 'android-17.0.0_r1', '', '', '2026-06-05'], cols).id, 'android-17.0.0_r1');
  });
});

describe('hostile values', () => {
  it('never lets markup, script or a link of the page into a release', () => {
    const releases = parsePage(
      page(
        '<tr><td>CP2A.260605.016</td><td><script>alert(1)</script>android-17.0.0_r1</td><td></td><td></td><td>2026-06-05</td></tr>',
        '<tr><td><img src=x onerror=alert(1)>CP2A.260605.016</td><td>android-17.0.0_r2</td><td></td><td></td><td>2026-06-05</td></tr>',
        '<tr><td>CP2A.260605.016</td><td><a href="https://evil.example/x">android-17.0.0_r3</a></td><td></td><td></td><td>2026-06-05</td></tr>',
        '<tr><td>CP2A.260605.016</td><td><a href="javascript:alert(1)">android-17.0.0_r4</a></td><td></td><td></td><td>2026-06-05</td></tr>',
      ),
    );
    assert.deepEqual(releases.map((r) => r.id), ['android-17.0.0_r2', 'android-17.0.0_r3', 'android-17.0.0_r4']);
    for (const r of releases) {
      assert.equal(r.url, PAGE_URL);
      assert.doesNotMatch(Object.values(r).join('|'), /[<>"]|evil|javascript|script|alert/);
    }
  });

  it('does not read a table hidden in a comment or a nested table', () => {
    const hidden = `<!-- ${page(row('CP2A.260605.016', 'android-17.0.0_r1'))} -->`;
    assert.deepEqual(parsePage(hidden), []);
    const nested = `<table><tr><td>${page(row('CP2A.260605.016', 'android-17.0.0_r1'))}</td></tr></table>`;
    assert.deepEqual(parsePage(nested), []);
  });

  it('treats prototype names and huge or odd cells as plain text', () => {
    const html = page(
      row('__proto__', 'android-17.0.0_r1'),
      row('CP2A.260605.016', `android-17.0.0_r2${'9'.repeat(100000)}`),
      row('\u0000CP2A.260605.016', 'android-17.0.0_r3'),
      row('CP2A.260605.016', 'android\u2011-17.0.0_r4'),
      row('CP2A.260605.016', 'android-1\u0660.0.0_r5'),
    );
    assert.deepEqual(parsePage(html), []);
    assert.equal(Object.keys(Object.prototype).length, 0);
  });

  it('is not fooled by a build id that only looks like a date', () => {
    assert.deepEqual(parsePage(page(row('CP2A.99999999.016', 'android-17.0.0_r1', ''))), []);
  });
});

describe('the Android adapter behind the Worker', () => {
  const worker = createWorker([android]);
  const ask = () =>
    worker.fetch(new Request(`${ORIGIN}/api/releases.json`), fakeEnv(null), fakeCtx());

  it('fetches only its own URL, without following a redirect, and serves the parsed page', async () => {
    stubUpstream(() => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const res = await ask();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, ID);
    assert.equal(body.stale, false);
    assert.equal(body.releases.length, 22);
    assert.ok(body.releases.every((r) => r.vendor === 'google' && r.source === ID));
    assert.deepEqual(state.upstream.calls.map((c) => c.url), [PAGE_URL]);
    assert.equal(state.upstream.calls[0].init.redirect, 'manual');
  });

  it('refuses a page whose layout changed instead of publishing nothing as fresh', async () => {
    stubUpstream(() => new Response('<html><body><p>New layout</p></body></html>'));
    const res = await ask();
    assert.equal(res.status, 503);
  });
});
