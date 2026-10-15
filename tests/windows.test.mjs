// Tests for the Microsoft adapter: the Windows 11 and Windows 10 release-information pages,
// read through the recorded first tables under tests/fixtures/microsoft/ (copied from the
// probe of 2026-10-12), plus malformed, empty and hostile input.
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FAMILIES } from '../deploy/families.js';
import { mergeReleases } from '../deploy/releases.js';
import { SOURCES } from '../deploy/sources/index.js';
import { createWorker } from '../deploy/worker.js';
import windows, {
  firstTable,
  ID,
  kbUrl,
  parseIsoDay,
  parsePage,
  productOf,
  tableRows,
  WINDOWS_10_URL,
  WINDOWS_11_URL,
} from '../deploy/sources/windows.js';
import {
  APPLE_ID,
  FEED,
  FEED_URL,
  ago,
  fakeCtx,
  fakeEnv,
  ORIGIN,
  seed,
  stubUpstream,
  useHarness,
} from './support/harness.mjs';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/microsoft/${name}`, import.meta.url)), 'utf8');
const WIN11 = fixture('windows11-release-information.html');
const WIN10 = fixture('windows10-release-information.html');
const LTSC = fixture('windows11-ltsc-table.html');

const HEADER =
  '<tr><th>Version</th><th>Servicing option</th><th>Availability date</th>' +
  '<th>End of updates: Home, Pro</th><th>End of updates: Enterprise</th>' +
  '<th>Latest update</th><th>Latest revision date</th><th>Latest build</th></tr>';
const row = ({
  version = '25H2',
  servicing = 'General Availability Channel',
  available = '2025-09-30',
  homeEnd = '2027-10-12',
  proEnd = '2028-10-10',
  update = '<a href="https://support.microsoft.com/help/5124010">2026-09 D</a>',
  revised = '2026-09-22',
  build = '26200.9550',
} = {}) =>
  `<tr><td>${version}</td><td>${servicing}</td><td>${available}</td><td>${homeEnd}</td>` +
  `<td>${proEnd}</td><td>${update}</td><td>${revised}</td><td>${build}</td></tr>`;
const page = (rows, product = '11', header = HEADER) =>
  `<html><head><title>Windows ${product} - release information | Microsoft Learn</title></head>` +
  `<body><table><tbody>${header}${rows.join('')}</tbody></table></body></html>`;

describe('the Windows adapter', () => {
  it('has the adapter shape, with the two release-information pages as its allowlist', () => {
    assert.equal(windows.id, ID);
    assert.equal(ID, 'microsoft-windows-release-health');
    assert.equal(windows.vendor, 'microsoft');
    assert.deepEqual(windows.urls, [WINDOWS_11_URL, WINDOWS_10_URL]);
    assert.equal(
      WINDOWS_11_URL,
      'https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information',
    );
    assert.equal(
      WINDOWS_10_URL,
      'https://learn.microsoft.com/en-us/windows/release-health/release-information',
    );
    for (const url of windows.urls) assert.equal(new URL(url).hostname, 'learn.microsoft.com');
    assert.equal(windows.parse, parsePage);
  });

  it('emits only families of its own vendor', () => {
    assert.deepEqual(FAMILIES.filter((family) => family.vendor === 'microsoft').map((f) => f.id), [
      'Windows',
    ]);
  });
});

describe('parsePage on the recorded Windows 11 table', () => {
  const releases = parsePage(WIN11);

  it('keeps one release per servicing version, newest first, and no other table', () => {
    // Rows of one revision date are ordered by id, as mergeReleases orders them.
    assert.deepEqual(
      releases.map((r) => [r.version, r.build]),
      [
        ['26H2', '26300.9550'],
        ['24H2', '26100.9550'],
        ['25H2', '26200.9550'],
        ['26H1', '28000.3086'],
        ['23H2', '22631.7584'],
      ],
    );
    assert.equal(new Set(releases.map((r) => r.id)).size, releases.length);
    for (let i = 1; i < releases.length; i += 1) {
      assert.ok(releases[i - 1].date >= releases[i].date);
    }
  });

  it('reads version, build, UTC date, title and the KB link of a row', () => {
    const r = releases.find((x) => x.version === '25H2');
    assert.deepEqual(r, {
      id: `${WINDOWS_11_URL}#25h2-26200.9550`,
      vendor: 'microsoft',
      family: 'Windows',
      version: '25H2',
      major: 25,
      stage: 'release',
      beta: null,
      build: '26200.9550',
      title: 'Windows 11 25H2 (2026-09 D)',
      date: '2026-09-22T00:00:00Z',
      url: 'https://support.microsoft.com/help/5124010',
      source: ID,
      line: '25H2',
    });
  });

  it('gives every row its feature update as its line', () => {
    for (const r of releases) assert.equal(r.line, r.version, r.id);
  });

  it('gives each row its own update label and link', () => {
    const byVersion = Object.fromEntries(releases.map((r) => [r.version, r]));
    assert.equal(byVersion['26H1'].url, 'https://support.microsoft.com/help/5124006');
    assert.equal(byVersion['23H2'].title, 'Windows 11 23H2 (2026-09 OOB)');
    assert.equal(byVersion['23H2'].url, 'https://support.microsoft.com/help/5129242');
    assert.equal(byVersion['26H2'].date, '2026-09-29T00:00:00Z');
  });

  it('marks every row a release and gives it the whole contract', () => {
    const keys = [
      'beta', 'build', 'date', 'family', 'id', 'line', 'major', 'source', 'stage', 'title', 'url',
      'vendor', 'version',
    ];
    for (const r of releases) {
      assert.deepEqual(Object.keys(r).sort(), keys);
      assert.equal(r.stage, 'release');
      assert.equal(r.beta, null);
      assert.match(r.build, /^\d{5}\.\d+$/);
      assert.match(r.date, /^\d{4}-\d\d-\d\dT00:00:00Z$/);
    }
  });

  it('does not mark a version in the title while some edition is still updated', () => {
    assert.ok(releases.every((r) => !r.title.includes('end of updates')));
  });
});

describe('parsePage on the recorded Windows 10 table', () => {
  it('reads the one servicing row and marks an ended version in its title', () => {
    assert.deepEqual(parsePage(WIN10), [
      {
        id: `${WINDOWS_10_URL}#22h2-19045.7727`,
        vendor: 'microsoft',
        family: 'Windows',
        version: '22H2',
        line: '22H2',
        major: 22,
        stage: 'release',
        beta: null,
        build: '19045.7727',
        title: 'Windows 10 22H2 (2026-09 OOB, end of updates)',
        date: '2026-09-14T00:00:00Z',
        url: 'https://support.microsoft.com/help/5129236',
        source: ID,
      },
    ]);
  });

  it('reads the "Latest update for ESU" column like "Latest update"', () => {
    assert.match(WIN10, /Latest update for ESU/);
    assert.equal(parsePage(WIN10).length, 1);
  });
});

describe('what is left out', () => {
  it('reads nothing from the LTSC table, which has no "End of updates" columns', () => {
    assert.match(LTSC, /Long-Term Servicing Channel/);
    assert.deepEqual(parsePage(LTSC), []);
  });

  it('skips a row of any servicing option but the General Availability Channel', () => {
    const html = page([
      row({ version: '24H2', servicing: 'Long-Term Servicing Channel (LTSC)', build: '26100.1' }),
      row({ version: '24H2', servicing: 'Preview', build: '26100.2' }),
      row({ version: '23H2', build: '22631.7584' }),
    ]);
    assert.deepEqual(parsePage(html).map((r) => r.version), ['23H2']);
  });

  it('keeps no release-notes text, only the contract fields', () => {
    const html = page([row({ update: '<a href="https://support.microsoft.com/help/5124010">2026-09 D</a>' })]);
    const [r] = parsePage(html);
    assert.doesNotMatch(JSON.stringify(r), /Servicing|Availability|General Availability/);
  });
});

describe('the scanner on odd and hostile input', () => {
  it('returns nothing for empty, missing or non-HTML input', () => {
    for (const bad of [undefined, null, '', ' ', 'not html', '<html></html>', 42, {}]) {
      assert.deepEqual(parsePage(bad), []);
    }
  });

  it('returns nothing when the title is not a Windows 11 or 10 release-information page', () => {
    const rows = [row()];
    for (const title of [
      'Windows 12 - release information',
      'Windows Server - release information',
      'Something else',
      '',
    ]) {
      const html = page(rows).replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
      assert.deepEqual(parsePage(html), [], title);
    }
    assert.deepEqual(parsePage(page(rows).replace(/<title>[^<]*<\/title>/, '')), []);
  });

  it('returns nothing when a needed column is missing or the header is not a header', () => {
    const noBuild = HEADER.replace('<th>Latest build</th>', '<th>Build</th>');
    assert.deepEqual(parsePage(page([row()], '11', noBuild)), []);
    const noEnds = HEADER.replaceAll('End of updates', 'Support ends');
    assert.deepEqual(parsePage(page([row()], '11', noEnds)), []);
    const tdHeader = HEADER.replaceAll('th>', 'td>');
    assert.deepEqual(parsePage(page([row()], '11', tdHeader)), []);
    assert.deepEqual(parsePage(page([])), [], 'a header and no rows');
  });

  it('costs linear work on a table of rows or cells that never close', () => {
    const started = performance.now();
    assert.deepEqual(parsePage(page([]).replace('</tbody>', `${'<tr>'.repeat(200000)}</tbody>`)), []);
    const cells = `<tr>${'<td>'.repeat(200000)}</tr>`;
    assert.deepEqual(parsePage(page([cells])), []);
    assert.ok(performance.now() - started < 2000, 'unclosed tags are read once, not rescanned');
  });

  it('costs linear work on a body of <table or <title tags that never end', () => {
    const started = performance.now();
    assert.deepEqual(parsePage('<table '.repeat(200000)), []);
    assert.deepEqual(parsePage('<title '.repeat(200000)), []);
    assert.equal(firstTable('<table '.repeat(200000)), null);
    assert.equal(productOf('<title '.repeat(200000)), null);
    assert.ok(performance.now() - started < 2000, 'an unclosed tag is not rescanned from every start');
  });

  it('refuses a revision date more than a day ahead of the clock', () => {
    const html = page([
      row({ version: '24H2', build: '26100.9550', revised: '2099-01-01' }),
      row({ version: '25H2' }),
    ]);
    assert.deepEqual(parsePage(html).map((r) => r.version), ['25H2']);
    // The url the Worker passes is the second argument and is not the clock.
    assert.deepEqual(windows.parse(html, WINDOWS_11_URL).map((r) => r.version), ['25H2']);
    assert.deepEqual(parsePage(html, '', Date.UTC(2099, 0, 1)).map((r) => r.version), ['24H2', '25H2']);
  });

  it('reads only the first table', () => {
    const html = page([row({ version: '24H2', build: '26100.9550' })]).replace(
      '</body>',
      `<table><tbody>${HEADER}${row({ version: '23H2', build: '22631.1' })}</tbody></table></body>`,
    );
    assert.deepEqual(parsePage(html).map((r) => r.version), ['24H2']);
  });

  it('skips a malformed row and keeps the good ones', () => {
    const html = page([
      row({ version: '24H2', build: '26100.9550' }),
      row({ version: 'Version 24H2' }),
      row({ version: '24H21' }),
      row({ version: '24H3' }),
      row({ version: '24H2<sup>1</sup>' }),
      row({ build: '26200' }),
      row({ build: '26200.9550.1' }),
      row({ build: 'abc' }),
      row({ revised: '2026-02-30' }),
      row({ revised: '22 Sep 2026' }),
      row({ revised: '' }),
      '<tr><td>25H2</td><td>General Availability Channel</td></tr>',
      '<tr><th>25H2</th>' + row().slice(4),
      row({ version: '23H2', build: '22631.7584' }),
    ]);
    // Both rows share a revision date, so they come out ordered by id.
    assert.deepEqual(parsePage(html).map((r) => r.version), ['23H2', '24H2']);
  });

  it('falls back to the page when the update cell has no usable link, and to a bare title', () => {
    const kb = '<a href="https://support.microsoft.com/help/5124010">';
    const [none] = parsePage(page([row({ update: '' })]));
    assert.equal(none.title, 'Windows 11 25H2');
    assert.equal(none.url, WINDOWS_11_URL);
    const [plain] = parsePage(page([row({ update: '2026-09 D' })]));
    assert.equal(plain.title, 'Windows 11 25H2 (2026-09 D)', 'a label without a link still names the update');
    assert.equal(plain.url, WINDOWS_11_URL);
    const [odd] = parsePage(page([row({ update: `${kb}see notes</a>` })]));
    assert.equal(odd.title, 'Windows 11 25H2', 'a label of another shape is not copied');
    assert.equal(odd.url, 'https://support.microsoft.com/help/5124010');
  });

  it('keeps no markup or script from a hostile cell', () => {
    const hostile = page([
      row({
        version: '25H2',
        update: '<a href="javascript:alert(1)">2026-09 D</a>',
        build: '26200.9550',
      }),
      row({ version: '<script>alert(1)</script>', build: '26100.1' }),
      row({ version: '24H2', build: '<img src=x onerror=alert(1)>' }),
      row({ version: '23H2', update: '<a href="https://support.microsoft.com/help/5129242"><b>2026-09</b> OOB</a>', build: '22631.7584' }),
    ]);
    const releases = parsePage(hostile);
    const byVersion = Object.fromEntries(releases.map((r) => [r.version, r]));
    assert.deepEqual(Object.keys(byVersion).sort(), ['23H2', '25H2']);
    assert.equal(byVersion['25H2'].url, WINDOWS_11_URL);
    assert.equal(byVersion['23H2'].title, 'Windows 11 23H2 (2026-09 OOB)');
    assert.doesNotMatch(JSON.stringify(releases), /[<>]|script|javascript/);
  });

  it('is bounded: a huge page, many rows and an oversized cell do not blow up', () => {
    const many = Array.from({ length: 500 }, (_, i) => row({ build: `26200.${i + 1}` }));
    assert.equal(parsePage(page(many)).length, 63, 'the header takes one of the 64 rows read');
    const huge = page([row()]) + 'x'.repeat(3 * 1024 * 1024);
    assert.equal(parsePage(huge).length, 1, 'the first table is before the cap');
    const late = 'x'.repeat(3 * 1024 * 1024) + page([row()]);
    assert.deepEqual(parsePage(late), [], 'a table past the cap is not read');
    const fat = page([row({ version: `25H2${' '.repeat(5000)}` })]);
    assert.deepEqual(parsePage(fat), []);
    const cells = `<tr>${'<td>1</td>'.repeat(100)}</tr>`;
    assert.deepEqual(parsePage(page([cells])), []);
  });

  it('survives an unclosed table or row', () => {
    assert.deepEqual(parsePage(page([row()]).replace('</table>', '')), []);
    assert.deepEqual(parsePage(page([row()]).replaceAll('</tr>', '')), []);
    assert.deepEqual(parsePage('<title>Windows 11 - release information</title><table>'), []);
  });
});

describe('the helpers', () => {
  it('parseIsoDay accepts real days and refuses the rest', () => {
    assert.equal(parseIsoDay('2026-09-29'), '2026-09-29T00:00:00Z');
    assert.equal(parseIsoDay('2028-02-29'), '2028-02-29T00:00:00Z');
    for (const bad of ['', null, undefined, '2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10',
      '2026-9-29', '29 Sep 2026', '2026-09-29T10:00:00Z', '2026-09-31']) {
      assert.equal(parseIsoDay(bad), null, String(bad));
    }
  });

  it('kbUrl keeps only https://support.microsoft.com/help/<digits>', () => {
    assert.equal(kbUrl('https://support.microsoft.com/help/5124010'), 'https://support.microsoft.com/help/5124010');
    assert.equal(
      kbUrl('https://support.microsoft.com/help/5124010?x=1#y'),
      'https://support.microsoft.com/help/5124010',
    );
    for (const bad of [
      '',
      null,
      undefined,
      'http://support.microsoft.com/help/5124010',
      'https://support.microsoft.com.evil.example/help/5124010',
      'https://evil.example/support.microsoft.com/help/5124010',
      'https://user:pw@support.microsoft.com/help/5124010',
      'https://support.microsoft.com:8443/help/5124010',
      'https://learn.microsoft.com/help/5124010',
      'https://support.microsoft.com/help/',
      'https://support.microsoft.com/help/abc',
      'https://support.microsoft.com/en-us/topic/x',
      'javascript:alert(1)',
      '//support.microsoft.com/help/5124010',
    ]) {
      assert.equal(kbUrl(bad), null, String(bad));
    }
  });

  it('productOf reads only the Windows 11 and 10 titles', () => {
    assert.equal(productOf('<title>Windows 11 - release information | Microsoft Learn</title>'), '11');
    assert.equal(productOf('<TITLE>Windows 10 - release information</TITLE>'), '10');
    for (const bad of ['', null, '<title>Windows 8 - release information</title>', '<p>Windows 11 - release information</p>']) {
      assert.equal(productOf(bad), null, String(bad));
    }
  });

  it('firstTable and tableRows split a table into rows of cells', () => {
    assert.equal(firstTable('<p>none</p>'), null);
    assert.equal(firstTable('<table><tr><td>a</td></tr>'), null);
    const rows = tableRows(firstTable('<table class="x"><tr><th>A</th></tr><tr><td> b&nbsp;c <a href="https://x.example/">d</a></td></tr></table><table>'));
    assert.deepEqual(rows, [
      [{ header: true, text: 'A', href: null }],
      [{ header: false, text: 'b c d', href: 'https://x.example/' }],
    ]);
  });
});

describe('the bundled snapshot', () => {
  it('holds exactly the rows the recorded tables give', () => {
    const snapshot = JSON.parse(
      readFileSync(fileURLToPath(new URL('../src/data/releases.json', import.meta.url)), 'utf8'),
    );
    const mine = snapshot.releases.filter((r) => r.source === ID);
    assert.deepEqual(mine, mergeReleases([], [...parsePage(WIN11), ...parsePage(WIN10)]));
    assert.equal(mine.length, 6);
  });
});

describe('the Worker with the Windows source', () => {
  useHarness();
  const worker = createWorker([windows]);
  const call = (path) => worker.fetch(new Request(ORIGIN + path), fakeEnv(null), fakeCtx());
  const routes = (table) =>
    stubUpstream((url) => (table[url] ? new Response(table[url]) : new Response('nope', { status: 503 })));

  it('fetches both pages and serves the rows of both', async () => {
    routes({ [WINDOWS_11_URL]: WIN11, [WINDOWS_10_URL]: WIN10 });
    const body = await (await call('/api/releases.json?vendor=microsoft')).json();
    assert.equal(body.source, ID);
    assert.equal(body.stale, false);
    assert.equal(body.releases.length, 6);
    assert.ok(body.releases.every((r) => r.vendor === 'microsoft' && r.source === ID));
  });

  it('is registered, and served beside Apple by a Worker built from the registered sources', async () => {
    // The other registered sources have their own tests; only these two are routed here.
    const shipped = createWorker(SOURCES.filter((s) => [APPLE_ID, ID].includes(s.id)));
    assert.ok(SOURCES.includes(windows));
    assert.equal(SOURCES.filter((s) => [APPLE_ID, ID].includes(s.id)).length, 2);
    routes({ [FEED_URL]: FEED, [WINDOWS_11_URL]: WIN11, [WINDOWS_10_URL]: WIN10 });
    const res = await shipped.fetch(new Request(`${ORIGIN}/api/releases.json`), fakeEnv(null), fakeCtx());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.source.split(',').sort(), [APPLE_ID, ID].sort());
    assert.deepEqual([...new Set(body.releases.map((r) => r.vendor))].sort(), ['apple', 'microsoft']);
  });

  it('keeps the page that parsed when the other one changed shape', async () => {
    routes({ [WINDOWS_11_URL]: '<html><title>Windows 11 - release information</title></html>', [WINDOWS_10_URL]: WIN10 });
    const res = await call('/api/releases.json');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).releases.length, 1, 'the page that parsed still counts');
  });

  it('answers 503 when neither page yields a release and there is no snapshot', async () => {
    routes({ [WINDOWS_11_URL]: '<html></html>', [WINDOWS_10_URL]: '<html></html>' });
    assert.equal((await call('/api/releases.json')).status, 503);
  });

  it('gives a row cached before lines existed its feature update as the line', async () => {
    const legacy = {
      id: 'legacy#24h2-26100',
      vendor: 'microsoft',
      family: 'Windows',
      version: '24H2',
      major: 24,
      stage: 'release',
      beta: null,
      build: '26100.1',
      title: 'Windows 11 24H2',
      date: '2026-01-01T00:00:00Z',
      url: 'https://support.microsoft.com/help/1',
      source: ID,
    };
    await seed(ago(60 * 1000), {}, ID, [legacy]);
    const res = await call('/api/releases.json?vendor=microsoft');
    const body = await res.json();
    assert.equal(body.releases.find((r) => r.id === legacy.id).line, '24H2');
  });
});
