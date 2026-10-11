// Tests for the shared release helpers and the Apple adapter's parser.
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FAMILIES, VENDORS, familyIds } from '../deploy/families.js';
import { mergeReleases, parseDate } from '../deploy/releases.js';
import apple, { FEED_URL, parseFeed, parseTitle } from '../deploy/sources/apple.js';

const FEED = readFileSync(fileURLToPath(new URL('./fixtures/releases.rss', import.meta.url)), 'utf8');

const item = (title, pubDate, id = title) =>
  `<item><title>${title}</title><link>https://developer.apple.com/news/releases/?id=${id}</link>` +
  `<guid>https://developer.apple.com/news/releases/?id=${id}</guid><pubDate>${pubDate}</pubDate></item>`;
const rss = (...items) => `<?xml version="1.0"?><rss><channel>${items.join('')}</channel></rss>`;

describe('parseDate', () => {
  it('converts named and numeric zones to UTC', () => {
    assert.equal(parseDate('Mon, 05 Oct 2026 11:00:00 PDT'), '2026-10-05T18:00:00Z');
    assert.equal(parseDate('Tue, 08 Dec 2026 11:00:00 PST'), '2026-12-08T19:00:00Z');
    assert.equal(parseDate('Tue, 08 Dec 2026 11:00:00 GMT'), '2026-12-08T11:00:00Z');
    assert.equal(parseDate('Tue, 08 Dec 2026 11:00:00 UT'), '2026-12-08T11:00:00Z');
    assert.equal(parseDate('Tue, 08 Dec 2026 11:00:00 +0200'), '2026-12-08T09:00:00Z');
    assert.equal(parseDate('Tue, 08 Dec 2026 11:00:00 -0530'), '2026-12-08T16:30:00Z');
    assert.equal(parseDate('8 Dec 2026 23:30 PST'), '2026-12-09T07:30:00Z');
    assert.equal(parseDate('29 Feb 2028 10:00:00 GMT'), '2028-02-29T10:00:00Z');
    assert.equal(parseDate('31 Oct 2026 10:00:00 GMT'), '2026-10-31T10:00:00Z');
  });

  it('refuses what it cannot read', () => {
    for (const bad of [
      '',
      'yesterday',
      'Mon, 05 Foo 2026 11:00:00 PDT',
      '05 Oct 2026 11:00:00 XYZ',
      'Wed, 31 Sep 2026 10:00:00 PDT',
      'Mon, 00 Oct 2026 10:00:00 PDT',
      '30 Feb 2026 10:00:00 GMT',
      '29 Feb 2027 10:00:00 GMT',
    ]) {
      assert.equal(parseDate(bad), null, bad);
    }
  });
});

describe('the families config', () => {
  it('lists the six Apple families, each with a colour accent', () => {
    assert.deepEqual(familyIds('apple'), ['iOS', 'iPadOS', 'macOS', 'watchOS', 'tvOS', 'visionOS']);
    assert.deepEqual(familyIds('nobody'), []);
    for (const family of FAMILIES) {
      assert.match(family.accent, /^#[0-9a-f]{6}$/i, family.id);
      assert.match(family.accentText, /^#[0-9a-f]{6}$/i, family.id);
      assert.ok(family.vendor && family.name, family.id);
    }
    assert.equal(new Set(FAMILIES.map((family) => family.id)).size, FAMILIES.length);
  });

  it('gives each family its accent and the darker text colour used on a light page', () => {
    assert.deepEqual(
      FAMILIES.map((family) => [family.id, family.accent, family.accentText]),
      [
        ['iOS', '#d7452f', '#c53b26'],
        ['iPadOS', '#a36f14', '#926312'],
        ['macOS', '#288b35', '#247c2f'],
        ['watchOS', '#158591', '#137883'],
        ['tvOS', '#7869d9', '#6a5ad5'],
        ['visionOS', '#cc3fa1', '#bd3293'],
      ],
    );
  });

  it('names each vendor and the page its data comes from', () => {
    assert.deepEqual(VENDORS.map((vendor) => vendor.id), ['apple']);
    for (const vendor of VENDORS) {
      assert.ok(vendor.name, vendor.id);
      assert.match(vendor.source.url, /^https:\/\//, vendor.id);
      assert.ok(vendor.source.name && vendor.source.hosts.length, vendor.id);
      assert.ok(FAMILIES.some((family) => family.vendor === vendor.id), vendor.id);
    }
    for (const family of FAMILIES) {
      assert.ok(VENDORS.some((vendor) => vendor.id === family.vendor), family.id);
    }
  });
});

describe('the Apple adapter', () => {
  it('has the adapter shape, with the feed as its only allowed URL', () => {
    assert.equal(apple.id, 'apple-developer-releases');
    assert.equal(apple.vendor, 'apple');
    assert.deepEqual(apple.urls, [FEED_URL]);
    assert.equal(FEED_URL, 'https://developer.apple.com/news/releases/rss/releases.rss');
    assert.equal(apple.parse, parseFeed);
  });
});

describe('parseTitle', () => {
  it('reads release, beta and RC titles', () => {
    assert.deepEqual(parseTitle('iOS 27.2 beta 3 (24B5099f)'), {
      vendor: 'apple',
      family: 'iOS',
      version: '27.2',
      major: 27,
      stage: 'beta',
      beta: 3,
      build: '24B5099f',
    });
    assert.deepEqual(parseTitle('macOS 27.0.1 (26A434)'), {
      vendor: 'apple',
      family: 'macOS',
      version: '27.0.1',
      major: 27,
      stage: 'release',
      beta: null,
      build: '26A434',
    });
    assert.deepEqual(parseTitle('iOS 27.1 RC (24B90)'), {
      vendor: 'apple',
      family: 'iOS',
      version: '27.1',
      major: 27,
      stage: 'rc',
      beta: null,
      build: '24B90',
    });
    assert.deepEqual(parseTitle('visionOS 27.1 RC 2 (24N90)'), {
      vendor: 'apple',
      family: 'visionOS',
      version: '27.1',
      major: 27,
      stage: 'rc',
      beta: 2,
      build: '24N90',
    });
    assert.equal(parseTitle('iPadOS 27 beta (24A5001a)').beta, null);
  });

  it('skips everything that is not one of the six families', () => {
    for (const title of [
      'Xcode 27.1 RC (27A9275)',
      'App Store Connect 3.3',
      'AirPods beta (9A292e)',
      'TestFlight Update',
    ]) {
      assert.equal(parseTitle(title), null, title);
    }
  });
});

describe('parseFeed on the recorded feed', () => {
  const releases = parseFeed(FEED);
  const count = (family) => releases.filter((r) => r.family === family).length;

  it('keeps the six families and nothing else', () => {
    assert.equal(releases.length, 28);
    assert.deepEqual(
      ['iOS', 'iPadOS', 'macOS', 'watchOS', 'tvOS', 'visionOS'].map(count),
      [6, 9, 3, 4, 3, 3],
    );
  });

  it('is newest first with unique ids', () => {
    assert.equal(new Set(releases.map((r) => r.id)).size, releases.length);
    for (let i = 1; i < releases.length; i += 1) {
      assert.ok(releases[i - 1].date >= releases[i].date, `${i} is out of order`);
    }
  });

  it('parses stage, build and the UTC date of a beta', () => {
    const ios = releases.find((r) => r.family === 'iOS' && r.version === '27.2');
    assert.equal(ios.stage, 'beta');
    assert.equal(ios.beta, 3);
    assert.equal(ios.build, '24B5099f');
    assert.equal(ios.title, 'iOS 27.2 beta 3 (24B5099f)');
    assert.equal(ios.date, '2026-10-05T18:00:00Z'); // 11:00 PDT
    assert.equal(ios.url, 'https://developer.apple.com/news/releases/?id=10052026a');
    assert.equal(ios.id, ios.url);
  });

  it('parses final releases', () => {
    const mac = releases.find((r) => r.family === 'macOS' && r.version === '27.0.1');
    assert.equal(mac.stage, 'release');
    assert.equal(mac.beta, null);
    assert.equal(mac.build, '26A434');
    assert.equal(mac.major, 27);
    assert.equal(releases.find((r) => r.family === 'iOS' && r.version === '15.8.8').major, 15);
  });

  it('gives every release the whole multi-vendor contract', () => {
    const keys = [
      'beta', 'build', 'date', 'family', 'id', 'major', 'source', 'stage', 'title', 'url',
      'vendor', 'version',
    ];
    for (const r of releases) {
      assert.deepEqual(Object.keys(r).sort(), keys);
      assert.equal(r.vendor, 'apple');
      assert.equal(r.source, 'apple-developer-releases');
      assert.match(r.date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      assert.match(r.url, /^https:\/\/developer\.apple\.com\//);
      assert.ok(['release', 'beta', 'rc'].includes(r.stage));
      assert.ok(r.build.length > 0);
      assert.equal(typeof r.major, 'number');
    }
  });
});

describe('parseFeed edge cases', () => {
  it('reads RC titles, CDATA and entities, and uses PST in winter', () => {
    const feed = rss(
      item('iOS 27.1 RC 2 (24B90)', 'Tue, 08 Dec 2026 11:00:00 PST', 'a'),
      '<item><title><![CDATA[macOS 27.1 RC (26B90)]]></title><link>https://developer.apple.com/x?a=1&amp;b=2</link>' +
        '<pubDate>Tue, 08 Dec 2026 10:00:00 GMT</pubDate></item>',
    );
    const [ios, mac] = parseFeed(feed);
    assert.deepEqual([ios.stage, ios.beta, ios.date], ['rc', 2, '2026-12-08T19:00:00Z']);
    assert.deepEqual([mac.family, mac.stage, mac.beta], ['macOS', 'rc', null]);
    assert.equal(mac.url, 'https://developer.apple.com/x?a=1&b=2');
    assert.equal(mac.id, mac.url); // no guid: the link is the id
  });

  it('drops items with a bad date, a foreign link or a non-https link', () => {
    const bad = (link, date = 'Mon, 05 Oct 2026 11:00:00 PDT') =>
      `<item><title>iOS 27.2 (24B1)</title><link>${link}</link><pubDate>${date}</pubDate></item>`;
    assert.deepEqual(parseFeed(rss(bad('https://evil.example/x'))), []);
    assert.deepEqual(parseFeed(rss(bad('http://developer.apple.com/x'))), []);
    assert.deepEqual(parseFeed(rss(bad('https://developer.apple.com/x', 'soon'))), []);
    assert.equal(parseFeed(rss(bad('https://developer.apple.com/x'))).length, 1);
  });

  it('survives empty and malformed input', () => {
    for (const text of ['', 'not xml', '<rss><item><title>iOS 27.2</title></item></rss>', undefined]) {
      assert.deepEqual(parseFeed(text), []);
    }
  });

  it('keeps no release-notes text, only title, build, date and link', () => {
    const feed =
      '<rss><channel><item><title>iOS 27.2 (24B1)</title><link>https://developer.apple.com/x</link>' +
      '<pubDate>Mon, 05 Oct 2026 11:00:00 PDT</pubDate>' +
      '<description>Long release notes that must not be stored.</description></item></channel></rss>';
    const [release] = parseFeed(feed);
    assert.equal(JSON.stringify(release).includes('release notes'), false);
  });
});

describe('mergeReleases', () => {
  const r = (id, date, extra = {}) => ({ id, date, ...extra });

  it('unions by id, newest first, and lets the second list win', () => {
    const merged = mergeReleases(
      [r('a', '2026-01-01T00:00:00Z', { build: 'old' }), r('b', '2026-03-01T00:00:00Z')],
      [r('a', '2026-01-01T00:00:00Z', { build: 'new' }), r('c', '2026-02-01T00:00:00Z')],
    );
    assert.deepEqual(merged.map((x) => x.id), ['b', 'c', 'a']);
    assert.equal(merged[2].build, 'new');
  });

  it('caps at 2000 and tolerates junk', () => {
    const many = Array.from({ length: 2100 }, (_, i) =>
      r(`id${i}`, new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString()),
    );
    const merged = mergeReleases(many, [null, { date: 'x' }, r('', 'y')]);
    assert.equal(merged.length, 2000);
    assert.equal(merged[0].id, 'id2099');
    assert.deepEqual(mergeReleases(undefined, null), []);
  });
});
