// Tests for the Android security adapter: the bulletin parser, the bulletin URLs, the patch
// levels of the build-numbers page and the join to releases. The fixtures are what the
// 2026-10-12 probe recorded (tests/fixtures/android-security/README.md); inputs built inside
// the tests are synthetic and say so.
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import adapter, {
  bulletinNote,
  bulletinUrl,
  match,
  neededBulletins,
  parseBulletin,
  patchLevelsByTag,
  pixelBulletinUrl,
  SOURCE_ID,
  validPatchLevel,
} from '../deploy/security/android.js';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const AOSP = read('./fixtures/android-security/aosp-2026-10.html');
const PIXEL = read('./fixtures/android-security/pixel-2026-10.html');
const BUILDS = read('./fixtures/google/build-numbers.html');
const RELEASES = JSON.parse(read('../src/data/releases.json')).releases;

const AOSP_URL = 'https://source.android.com/docs/security/bulletin/2026/2026-10-01';
const PIXEL_URL = 'https://source.android.com/docs/security/bulletin/pixel/2026/2026-10-01';
const CHECKED = '2026-10-12T09:00:00Z';
const sortedUnique = (list) => list.every((item, i) => i === 0 || list[i - 1] < item);
const severities = (bulletin) => Object.fromEntries(bulletin.cves.map((c) => [c.id, c.severity]));

// Synthetic: a CVE table with the AOSP header, one row per [id, severity] pair.
const cveTable = (rows, last = 'Updated AOSP versions') =>
  `<table><tr><th>CVE</th><th>References</th><th>Type</th><th>Severity</th><th>${last}</th></tr>${rows
    .map(
      ([id, severity]) =>
        `<tr><td>\n ${id}\n</td><td>A-1</td><td>EoP</td><td>${severity}</td><td>14</td></tr>`,
    )
    .join('')}</table>`;
// Synthetic: a page that looks like the bulletin of `level`'s month, with the given tables.
const page = (level, body = '') =>
  `<title>Android Security Bulletin—Test | Android Open Source Project</title>` +
  `<em>Published  October 5, 2026</em><p>Security patch levels of\n  ${level} or higher ` +
  `address all of these issues.</p>${body}`;

describe('parseBulletin: the AOSP bulletin of October 2026', () => {
  const bulletin = parseBulletin(AOSP);

  it('reads the title, the dates and the patch level', () => {
    assert.equal(bulletin.title, 'Android Security Bulletin—October 2026');
    assert.equal(bulletin.published, '2026-10-05');
    assert.equal(bulletin.updated, '2026-10-08');
    assert.deepEqual(bulletin.patchLevels, ['2026-10-01']);
  });

  it('lists the 7 + 18 CVEs of the two CVE tables, sorted and unique', () => {
    assert.equal(bulletin.cves.length, 25);
    const ids = bulletin.cves.map((cve) => cve.id);
    assert.ok(sortedUnique(ids));
    assert.ok(ids.every((id) => /^CVE-\d{4}-\d{4,}$/.test(id)));
    const counts = {};
    for (const { severity } of bulletin.cves) counts[severity] = (counts[severity] ?? 0) + 1;
    assert.deepEqual(counts, { Critical: 7, High: 18 });
  });

  it('keeps the severity label as the vendor wrote it', () => {
    const by = severities(bulletin);
    assert.equal(by['CVE-2026-58865'], 'Critical');
    assert.equal(by['CVE-2026-55270'], 'High');
    assert.equal(by['CVE-2026-55286'], 'High');
  });

  it('reads a CVE whose reference is plain text, not a link', () => {
    assert.equal(severities(bulletin)['CVE-2026-55265'], 'Critical');
  });

  it('keeps no text but ids, labels, title and dates', () => {
    assert.deepEqual(Object.keys(bulletin), ['title', 'published', 'updated', 'patchLevels', 'cves']);
    for (const cve of bulletin.cves) assert.deepEqual(Object.keys(cve), ['id', 'severity']);
  });
});

describe('parseBulletin: the Pixel bulletin of October 2026', () => {
  const bulletin = parseBulletin(PIXEL);

  it('reads the title, the single date and the patch level', () => {
    assert.equal(bulletin.title, 'Pixel Update Bulletin—October 2026');
    assert.equal(bulletin.published, '2026-10-06');
    assert.equal(bulletin.updated, null);
    assert.deepEqual(bulletin.patchLevels, ['2026-10-05']);
  });

  it('lists the 2 + 4 CVEs of the two CVE tables', () => {
    assert.deepEqual(bulletin.cves, [
      { id: 'CVE-2026-0198', severity: 'High' },
      { id: 'CVE-2026-55307', severity: 'Critical' },
      { id: 'CVE-2026-55330', severity: 'Critical' },
      { id: 'CVE-2026-56906', severity: 'High' },
      { id: 'CVE-2026-56936', severity: 'High' },
      { id: 'CVE-2026-56952', severity: 'Critical' },
    ]);
  });
});

describe('parseBulletin: tables and sentences', () => {
  it('ignores the Subcomponent/CVE table that lists several ids in a cell', () => {
    const table =
      '<table><tr><th>Subcomponent</th><th>CVE</th></tr>' +
      '<tr><td>WiFi</td><td>CVE-2026-45524, CVE-2026-49878</td></tr></table>';
    assert.deepEqual(parseBulletin(page('2026-10-01', table)).cves, []);
    // Added to a real CVE table it adds nothing: the ids are those of the table before it.
    const both = parseBulletin(page('2026-10-01', cveTable([['CVE-2026-45524', 'High']]) + table));
    assert.deepEqual(both.cves, [{ id: 'CVE-2026-45524', severity: 'High' }]);
  });

  it('ignores the Abbreviation, Prefix and Version history tables', () => {
    const others =
      '<table><tr><th>Abbreviation</th><th>Definition</th></tr><tr><td>EoP</td><td>x</td></tr></table>' +
      '<table><tr><th>Prefix</th><th>Reference</th></tr><tr><td>A-</td><td>Android bug ID</td></tr></table>' +
      '<table><tr><th>Version</th><th>Date</th><th>Notes</th></tr><tr><td>1.0</td><td>x</td><td>y</td></tr></table>';
    assert.deepEqual(parseBulletin(page('2026-10-01', others)).cves, []);
  });

  it('needs a Severity column, and the CVE column first', () => {
    const noSeverity = '<table><tr><th>CVE</th><th>Type</th></tr><tr><td>CVE-2026-1111</td><td>EoP</td></tr></table>';
    const notFirst = '<table><tr><th>Type</th><th>CVE</th><th>Severity</th></tr><tr><td>EoP</td><td>CVE-2026-1111</td><td>High</td></tr></table>';
    assert.deepEqual(parseBulletin(page('2026-10-01', noSeverity + notFirst)).cves, []);
  });

  it('normalises ids, drops duplicates and skips rows that are not CVE ids', () => {
    const rows = [
      ['cve-2026-0002', 'High'],
      ['CVE-2026-0001', 'Critical'],
      ['CVE-2026-0002', 'Low'],
      ['CVE-2026-12', 'High'],
      ['CVE-2026-100000', 'High'],
      ['CVE-2026-99999', 'High'],
      ['See above', 'High'],
      ['CVE-2026-0003 CVE-2026-0004', 'High'],
    ];
    const ids = parseBulletin(page('2026-10-01', cveTable(rows))).cves.map((cve) => cve.id);
    // The same order the payload contract checks: plain text order, not numeric.
    assert.deepEqual(ids, ['CVE-2026-0001', 'CVE-2026-0002', 'CVE-2026-100000', 'CVE-2026-99999']);
    assert.equal(
      severities(parseBulletin(page('2026-10-01', cveTable(rows))))['CVE-2026-0002'],
      'High',
      'the first row of an id wins',
    );
  });

  it('gives a severity of null for an empty cell or a cell that is not a label', () => {
    const rows = [
      ['CVE-2026-0001', ''],
      ['CVE-2026-0002', '<a href="x">Moderate</a>'],
      ['CVE-2026-0003', '9.8'],
      ['CVE-2026-0004', 'x'.repeat(60)],
      ['CVE-2026-0005', 'N/A'],
    ];
    const by = severities(parseBulletin(page('2026-10-01', cveTable(rows))));
    assert.deepEqual(by, {
      'CVE-2026-0001': null,
      'CVE-2026-0002': 'Moderate',
      'CVE-2026-0003': null,
      'CVE-2026-0004': null,
      'CVE-2026-0005': 'N/A',
    });
  });

  it('reads the patch level sentence wrapped across lines, "higher" or "later"', () => {
    const wrapped = '<p>Security patch levels\n   of\n 2026-10-01\n or   higher address</p>';
    assert.deepEqual(parseBulletin(wrapped).patchLevels, ['2026-10-01']);
    assert.deepEqual(parseBulletin('security patch levels of 2026-10-05 or later').patchLevels, [
      '2026-10-05',
    ]);
    const two =
      'Security patch levels of 2026-10-05 or higher. Security patch levels of 2026-10-01 or higher. ' +
      'Security patch levels of 2026-10-01 or higher.';
    assert.deepEqual(parseBulletin(two).patchLevels, ['2026-10-01', '2026-10-05']);
  });

  it('ignores a level that is not a real day or has no "or higher"', () => {
    assert.deepEqual(parseBulletin('Security patch levels of 2026-13-01 or higher').patchLevels, []);
    assert.deepEqual(parseBulletin('Security patch levels of 2026-02-30 or higher').patchLevels, []);
    assert.deepEqual(parseBulletin('The 2026-10-01 security patch level').patchLevels, []);
  });

  it('ignores dates and sentences inside comments, scripts and styles', () => {
    const hidden =
      '<!-- Published May 1, 2020 --><script>var s = "Published May 2, 2020 ' +
      'Security patch levels of 2020-05-01 or higher";</script><style>/* Updated May 3, 2020 */</style>';
    const bulletin = parseBulletin(hidden + '<em>Published October 5, 2026</em>');
    assert.equal(bulletin.published, '2026-10-05');
    assert.equal(bulletin.updated, null);
    assert.deepEqual(bulletin.patchLevels, []);
  });

  it('reads no date from a bad month or day', () => {
    assert.equal(parseBulletin('Published Octember 5, 2026').published, null);
    assert.equal(parseBulletin('Published February 30, 2026').published, null);
  });

  it('never throws and gives the empty shape for input that is not a bulletin', () => {
    const empty = { title: null, published: null, updated: null, patchLevels: [], cves: [] };
    for (const input of [undefined, null, '', 'plain text', '<table', '<!-- ', '<title>', 42]) {
      assert.deepEqual(parseBulletin(input), empty);
    }
  });

  it('drops a CVE table that is never closed', () => {
    const open = cveTable([['CVE-2026-0001', 'High']]).replace('</table>', '');
    assert.deepEqual(parseBulletin(page('2026-10-01', open)).cves, []);
  });
});

describe('bulletin URLs', () => {
  it('uses the year folder from 2026 on', () => {
    assert.equal(bulletinUrl('2026-10-05'), AOSP_URL);
    assert.equal(bulletinUrl('2026-01-05'), 'https://source.android.com/docs/security/bulletin/2026/2026-01-01');
  });

  it('has no year folder before 2026', () => {
    assert.equal(bulletinUrl('2025-12-05'), 'https://source.android.com/docs/security/bulletin/2025-12-01');
    assert.equal(bulletinUrl('2025-03-01'), 'https://source.android.com/docs/security/bulletin/2025-03-01');
  });

  it('is the same for every patch level of a month', () => {
    assert.equal(bulletinUrl('2026-10-01'), bulletinUrl('2026-10-05'));
  });

  it('gives null for a bad patch level', () => {
    for (const bad of ['', 'x', null, undefined, '2026-13-01', '2026-10-32', '2026-1-01', 20261001]) {
      assert.equal(bulletinUrl(bad), null);
      assert.equal(pixelBulletinUrl(bad), null);
    }
  });

  it('has a separate Pixel URL, for 2026 only, never the AOSP one', () => {
    assert.equal(pixelBulletinUrl('2026-10-05'), PIXEL_URL);
    assert.notEqual(pixelBulletinUrl('2026-10-05'), bulletinUrl('2026-10-05'));
    assert.equal(pixelBulletinUrl('2025-12-05'), null);
  });

  it('accepts only real days as patch levels', () => {
    assert.equal(validPatchLevel('2026-10-05'), '2026-10-05');
    assert.equal(validPatchLevel('2024-02-29'), '2024-02-29');
    assert.equal(validPatchLevel('2025-02-29'), null);
    assert.equal(validPatchLevel(' 2026-10-05'), null);
  });
});

describe('patchLevelsByTag: the build-numbers page', () => {
  const levels = patchLevelsByTag(BUILDS);

  it('takes the exact string of the Security patch level cell', () => {
    assert.equal(levels.get('android-17.0.0_r1'), '2026-06-05');
    assert.equal(levels.get('android-16.0.0_r4'), '2025-12-05');
    assert.equal(levels.get('android-15.0.0_r20'), '2025-03-05');
  });

  it('does not derive the level from the release date', () => {
    // android-15.0.0_r25 is dated 2025-04-05 by its build id; its cell says 2025-02-05.
    const r25 = RELEASES.find((row) => row.id === 'android-15.0.0_r25');
    assert.ok(r25.date.startsWith('2025-04-05'));
    assert.equal(levels.get('android-15.0.0_r25'), '2025-02-05');
    assert.equal(levels.get('android-15.0.0_r24'), '2025-01-05');
  });

  it('has a level for every Android release of releases.json', () => {
    const android = RELEASES.filter((row) => row.family === 'Android');
    assert.ok(android.length > 0);
    for (const row of android) assert.match(levels.get(row.id) ?? '', /^\d{4}-\d{2}-\d{2}$/, row.id);
  });

  const row = (tag, level) => `<tr><td>CP2A.260605.016</td><td>${tag}</td><td>A</td><td></td><td>${level}</td></tr>`;
  const header = '<tr><th>Build ID</th><th>Tag</th><th>Version</th><th>Supported devices</th><th>Security patch level</th></tr>';
  const html = (...rows) => `<table>${header}${rows.join('')}</table>`;

  it('leaves a tag out when its level is missing, bad or contradicted (synthetic)', () => {
    const synthetic = patchLevelsByTag(
      html(
        row('android-1.0.0_r1', ''),
        row('android-1.0.0_r2', 'soon'),
        row('android-1.0.0_r3', '2026-02-30'),
        row('android-1.0.0_r4', '2026-01-05'),
        row('android-1.0.0_r5', '2026-01-05'),
        row('android-1.0.0_r5', '2026-01-05'),
        row('android-1.0.0_r6', '2026-01-05'),
        row('android-1.0.0_r6', '2026-02-05'),
      ),
    );
    assert.deepEqual([...synthetic], [
      ['android-1.0.0_r4', '2026-01-05'],
      ['android-1.0.0_r5', '2026-01-05'],
    ]);
  });

  it('is empty when the page has no build table', () => {
    assert.equal(patchLevelsByTag('<table><tr><th>Codename</th></tr></table>').size, 0);
    assert.equal(patchLevelsByTag('').size, 0);
    assert.equal(patchLevelsByTag(null).size, 0);
  });
});

describe('match', () => {
  // Synthetic releases and patch levels; the bulletins are the recorded October page and
  // synthetic pages built by page().
  const rel = (id, over = {}) => ({ id, vendor: 'google', family: 'Android', stage: 'release', ...over });
  const releases = [
    rel('listed-a'),
    rel('listed-b'),
    rel('empty'),
    rel('missing-bulletin'),
    rel('no-level'),
    rel('bad-level'),
    rel('beta', { stage: 'beta' }),
    rel('wrong-month'),
    rel('no-date'),
    { id: 'routeros-7', vendor: 'mikrotik', family: 'RouterOS', stage: 'release' },
  ];
  const patchLevels = new Map([
    ['listed-a', '2026-10-05'],
    ['listed-b', '2026-10-01'],
    ['empty', '2026-08-05'],
    ['missing-bulletin', '2026-09-05'],
    ['bad-level', 'soon'],
    ['beta', '2026-10-05'],
    ['wrong-month', '2026-07-05'],
    ['no-date', '2026-06-05'],
    ['routeros-7', '2026-10-05'],
  ]);
  const bulletins = new Map([
    [AOSP_URL, parseBulletin(AOSP)],
    [bulletinUrl('2026-08-01'), parseBulletin(page('2026-08-01'))],
    // The page at the July URL names a September level: not the July bulletin.
    [bulletinUrl('2026-07-01'), parseBulletin(page('2026-09-01'))],
    // A page with no publish date is not recognised as a bulletin.
    [bulletinUrl('2026-06-01'), parseBulletin('<p>Security patch levels of 2026-06-01 or higher</p>')],
  ]);
  const result = match(releases, patchLevels, bulletins, CHECKED);

  it('lists the CVEs of the release\'s own bulletin month', () => {
    const bulletin = parseBulletin(AOSP);
    for (const id of ['listed-a', 'listed-b']) {
      const entry = result.releases[id];
      assert.equal(entry.status, 'listed');
      assert.deepEqual(entry.notes, [AOSP_URL]);
      assert.deepEqual(entry.cves, bulletin.cves.map((cve) => cve.id));
      assert.equal(entry.count, 25);
      assert.equal(entry.checkedAt, CHECKED);
    }
    assert.equal(result.releases['listed-a'].patchLevel, '2026-10-05');
    assert.equal(result.releases['listed-b'].patchLevel, '2026-10-01');
  });

  it('stores one note per bulletin, in the payload shape', () => {
    assert.deepEqual(Object.keys(result.notes).sort(), [AOSP_URL, bulletinUrl('2026-08-01')].sort());
    const note = result.notes[AOSP_URL];
    assert.deepEqual(Object.keys(note), ['source', 'title', 'published', 'cves', 'noCveEntries']);
    assert.equal(note.source, SOURCE_ID);
    assert.equal(note.title, 'Android Security Bulletin—October 2026');
    assert.equal(note.published, '2026-10-05');
    assert.equal(note.noCveEntries, false);
    assert.equal(note.cves.length, 25);
    assert.ok(sortedUnique(note.cves.map((cve) => cve.id)));
  });

  it('says no-cve-entries, count 0, for a bulletin that was read and lists none', () => {
    const entry = result.releases.empty;
    assert.equal(entry.status, 'no-cve-entries');
    assert.equal(entry.count, 0);
    assert.deepEqual(entry.cves, []);
    assert.deepEqual(entry.notes, [bulletinUrl('2026-08-01')]);
    assert.equal(entry.patchLevel, '2026-08-05');
    assert.equal(result.notes[bulletinUrl('2026-08-01')].noCveEntries, true);
  });

  it('is unavailable, with its patch level, when the bulletin was not read', () => {
    for (const id of ['missing-bulletin', 'wrong-month', 'no-date']) {
      const entry = result.releases[id];
      assert.equal(entry.status, 'unavailable', id);
      assert.deepEqual(entry.notes, []);
      assert.deepEqual(entry.cves, []);
      assert.equal(entry.count, null);
      assert.equal(entry.patchLevel, patchLevels.get(id));
    }
  });

  it('is not-found, patch level null, without a patch level', () => {
    for (const id of ['no-level', 'bad-level']) {
      const entry = result.releases[id];
      assert.equal(entry.status, 'not-found', id);
      assert.equal(entry.patchLevel, null);
      assert.equal(entry.count, null);
      assert.deepEqual(entry.notes, []);
    }
  });

  it('is not-applicable for a pre-release, even with a patch level and a bulletin', () => {
    const entry = result.releases.beta;
    assert.equal(entry.status, 'not-applicable');
    assert.equal(entry.count, null);
    assert.equal(entry.patchLevel, null);
    assert.deepEqual(entry.notes, []);
  });

  it('describes Android rows only', () => {
    assert.equal('routeros-7' in result.releases, false);
    assert.equal(Object.keys(result.releases).length, releases.length - 1);
  });

  it('never joins the Pixel bulletin to a release', () => {
    const withPixel = new Map(bulletins).set(PIXEL_URL, parseBulletin(PIXEL));
    const again = match(releases, patchLevels, withPixel, CHECKED);
    assert.deepEqual(again, result);
    assert.equal(PIXEL_URL in again.notes, false);
  });

  it('keeps the contract: counts, sorted lists, https notes that exist', () => {
    for (const [id, entry] of Object.entries(result.releases)) {
      assert.ok(sortedUnique(entry.notes) && sortedUnique(entry.cves), id);
      for (const url of entry.notes) assert.ok(url in result.notes, id);
      if (entry.status === 'listed') assert.equal(entry.count, entry.cves.length);
      if (entry.status === 'no-cve-entries') assert.equal(entry.count, 0);
      assert.ok(entry.patchLevel === null || /^\d{4}-\d{2}-\d{2}$/.test(entry.patchLevel));
    }
    for (const url of Object.keys(result.notes)) assert.equal(new URL(url).protocol, 'https:');
  });

  it('reads the real release rows against the recorded patch levels', () => {
    const levels = patchLevelsByTag(BUILDS);
    const real = match(RELEASES, levels, new Map([[AOSP_URL, parseBulletin(AOSP)]]), CHECKED);
    const android = RELEASES.filter((row) => row.family === 'Android');
    assert.equal(Object.keys(real.releases).length, android.length);
    for (const row of android) {
      // None of these months is the October 2026 bulletin, which is the only one read.
      assert.equal(real.releases[row.id].status, 'unavailable', row.id);
      assert.equal(real.releases[row.id].patchLevel, levels.get(row.id), row.id);
    }
  });

  it('lists the bulletins a snapshot has to read', () => {
    assert.deepEqual(neededBulletins(releases, patchLevels), [
      bulletinUrl('2026-06-01'),
      bulletinUrl('2026-07-01'),
      bulletinUrl('2026-08-01'),
      bulletinUrl('2026-09-01'),
      AOSP_URL,
    ]);
    const real = neededBulletins(RELEASES, patchLevelsByTag(BUILDS));
    assert.ok(real.includes('https://source.android.com/docs/security/bulletin/2026/2026-06-01'));
    assert.ok(real.includes('https://source.android.com/docs/security/bulletin/2025-12-01'));
    assert.ok(sortedUnique(real));
  });
});

describe('the adapter', () => {
  it('has the id of the notes it writes and a note builder', () => {
    assert.equal(adapter.id, SOURCE_ID);
    assert.equal(adapter.host, 'source.android.com');
    assert.equal(bulletinNote(parseBulletin(PIXEL), 'android-pixel-bulletin').source, 'android-pixel-bulletin');
  });
});
