// Tests for the Valve adapter (SteamOS from the Steam news of app 1675200).
// The recorded fixtures are what the 2026-10-12 probe read. getnewsforapp.json and news.rss hold
// only Steam Client updates; getnewsforapp-steamos-titles.json holds the real SteamOS titles,
// dates and tags of the probe's title_matches block, with no gid or url because the probe
// recorded none (see tests/fixtures/valve/README.md).
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isSource } from '../deploy/sources/index.js';
import steamos, {
  FALLBACK_URL,
  ID,
  NEWS_PAGE,
  NEWS_URL,
  parse,
  parseFeed,
  parseNews,
  parseTitle,
} from '../deploy/sources/steamos.js';

const read = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/valve/${name}`, import.meta.url)), 'utf8');
const RECORDED_JSON = read('getnewsforapp.json');
const RECORDED_RSS = read('news.rss');
const TITLES = read('getnewsforapp-steamos-titles.json');
const PAGE = (slug) => `${NEWS_PAGE}#${slug}`;

const post = (over) => ({
  title: 'SteamOS 3.7.15',
  url: 'https://store.steampowered.com/news/app/1675200/view/1',
  date: 1791700000,
  feedname: 'steam_community_announcements',
  tags: ['patchnotes', 'stablechannel'],
  ...over,
});
const doc = (...items) => JSON.stringify({ appnews: { newsitems: items } });

describe('the Valve adapter', () => {
  it('has the adapter shape, with the news API as its only allowed URL', () => {
    assert.equal(steamos.id, 'valve-steam-news');
    assert.equal(steamos.id, ID);
    assert.equal(steamos.vendor, 'valve');
    assert.deepEqual(steamos.urls, [NEWS_URL]);
    assert.match(NEWS_URL, /^https:\/\/api\.steampowered\.com\/ISteamNews\/GetNewsForApp\/v2\/\?appid=1675200&/);
    assert.equal(FALLBACK_URL, 'https://store.steampowered.com/feeds/news/app/1675200');
    assert.equal(typeof steamos.parse, 'function');
    assert.ok(isSource(steamos));
  });
});

describe('parseTitle', () => {
  it('reads a SteamOS version and maps the channel tag to a stage', () => {
    assert.deepEqual(parseTitle('SteamOS 3.7.13', ['patchnotes', 'stablechannel']), {
      vendor: 'valve',
      family: 'SteamOS',
      version: '3.7.13',
      major: 3,
      stage: 'release',
      beta: null,
      build: '',
    });
    assert.equal(parseTitle('SteamOS 3.7.14', ['previewchannel']).stage, 'beta');
    assert.equal(parseTitle('SteamOS 3.8.0', ['betachannel']).stage, 'beta');
  });

  it('lets the stable tag win over the pre-release tags, and falls back to the title words', () => {
    assert.equal(parseTitle('SteamOS 3.7.13', ['stablechannel', 'betachannel', 'previewchannel']).stage, 'release');
    assert.equal(parseTitle('SteamOS 3.7.13', ['betachannel', 'previewchannel']).stage, 'beta');
    assert.equal(parseTitle('SteamOS 3.7.14 Preview').stage, 'beta');
    assert.equal(parseTitle('SteamOS 3.7.14 Beta').stage, 'beta');
    assert.equal(parseTitle('SteamOS 3.7.13 Stable').stage, 'release');
  });

  it('reads a title with punctuation after the version', () => {
    assert.equal(parseTitle('SteamOS 3.7.13 Stable: Steam Deck update').stage, 'release');
    assert.equal(parseTitle('SteamOS 3.7.14 Preview, now with fixes').stage, 'beta');
    assert.equal(parseTitle('SteamOS 3.7.14: fixes', ['stablechannel']).version, '3.7.14');
    assert.equal(parseTitle(`SteamOS 3.7.13 Stable ${'x'.repeat(200)}`), null);
    assert.equal(parseTitle('SteamOS 3.7.13.1.2 Stable'), null);
  });

  it('takes a build id only from the title', () => {
    assert.equal(parseTitle('SteamOS 3.7.13 Stable (20250522.1)').build, '20250522.1');
    assert.equal(parseTitle('SteamOS 3.7.13 Stable').build, '');
    assert.equal(parseTitle('SteamOS 3.7.13 Stable 2025052.1').build, '');
  });

  it('refuses what is not a SteamOS release', () => {
    for (const title of [
      'Steam Beta Client Update: October 10th',
      'Steam Client Update: October 7th',
      'SteamOS',
      'SteamOS beta',
      'SteamOS 3',
      'SteamOS 3.7.13 <script>',
      'Steam Deck Update 3.7.13',
      'Using SteamOS 3.7.13',
      '',
      null,
      undefined,
    ]) {
      assert.equal(parseTitle(title, ['stablechannel']), null, String(title));
    }
    // A version with no channel at all is not guessed.
    assert.equal(parseTitle('SteamOS 3.7.13', ['patchnotes']), null);
    assert.equal(parseTitle('SteamOS 3.7.13', 'stablechannel'), null);
  });
});

describe('parseNews', () => {
  it('skips every recorded Steam Client update', () => {
    assert.deepEqual(parseNews(RECORDED_JSON), []);
  });

  it('keeps all 19 real SteamOS posts of the probe, newest first, without a gid or a link', () => {
    const releases = parseNews(TITLES);
    assert.equal(releases.length, 19);
    assert.equal(releases.filter((r) => r.stage === 'release').length, 7);
    assert.deepEqual(
      releases.slice(0, 4).map((r) => [r.id, r.version, r.stage, r.build, r.date]),
      [
        [PAGE('steamos-3.9.2-beta'), '3.9.2', 'beta', '', '2026-09-25T23:16:19Z'],
        [PAGE('steamos-3.8.28'), '3.8.28', 'release', '', '2026-09-25T00:28:44Z'],
        [PAGE('steamos-3.8.28-beta'), '3.8.28', 'beta', '', '2026-09-23T00:21:31Z'],
        [PAGE('steamos-3.9.1-preview'), '3.9.1', 'beta', '', '2026-09-14T23:24:24Z'],
      ],
    );
    for (const r of releases) {
      assert.deepEqual(Object.keys(r).sort(), [
        'beta', 'build', 'date', 'family', 'id', 'major', 'source', 'stage', 'title', 'url',
        'vendor', 'version',
      ]);
      assert.equal(r.vendor, 'valve');
      assert.equal(r.family, 'SteamOS');
      assert.equal(r.source, ID);
      assert.equal(r.major, 3);
      assert.equal(r.url, NEWS_PAGE);
    }
  });

  it('maps the real channel tags: stable wins, beta and preview are betas', () => {
    const stage = Object.fromEntries(parseNews(TITLES).map((r) => [r.title, r.stage]));
    assert.equal(stage['SteamOS 3.8.28'], 'release');
    assert.equal(stage['SteamOS 3.8.12'], 'release'); // stable, beta and preview tags together
    assert.equal(stage['SteamOS 3.8.28 Beta'], 'beta');
    assert.equal(stage['SteamOS 3.9.1 Preview'], 'beta'); // previewchannel alone
    assert.equal(stage['SteamOS 3.8.21 Beta'], 'beta'); // with moderation tags in between
  });

  it('keeps a link on the Steam hosts and replaces any other with the news page', () => {
    const good = 'https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1';
    assert.equal(parseNews(doc(post({ url: good })))[0].url, good);
    for (const url of [
      'http://store.steampowered.com/news/app/1675200/view/1',
      'https://store.steampowered.com.evil.example/x',
      'https://evil.example/store.steampowered.com',
      'javascript:alert(1)',
      'steamcommunity.com/x',
      'https://steamcommunity.com/games/1675200/announcements/detail/1',
      ['https://store.steampowered.com/x'],
      undefined,
      42,
    ]) {
      assert.equal(parseNews(doc(post({ url })))[0].url, NEWS_PAGE, String(url));
    }
  });

  it('never keeps the post text', () => {
    const text = parseNews(doc(post({ contents: 'Fixed a secret thing', author: 'someone' })));
    assert.ok(!JSON.stringify(text).includes('secret'));
    assert.ok(!JSON.stringify(text).includes('someone'));
  });

  it('skips malformed entries and keeps the good ones', () => {
    const releases = parseNews(
      doc(
        null,
        'text',
        42,
        post({ date: 'soon' }),
        post({ date: 0 }),
        post({ date: -5 }),
        post({ date: 1.5 }),
        post({ date: 1e20 }),
        post({ title: 7 }),
        post({ title: ['SteamOS 3.7.15'] }),
        post({ title: { toString: 1 } }),
        post({ title: 'Steam Client Update' }),
        post({ tags: 'stablechannel' }),
        post({ title: 'SteamOS 3.7.16', tags: ['stablechannel'] }),
      ),
    );
    assert.deepEqual(releases.map((r) => r.id), [PAGE('steamos-3.7.16')]);
  });

  it('returns nothing for an empty or unreadable document', () => {
    for (const text of [
      '',
      'not json',
      '{',
      '[]',
      'null',
      '{}',
      '{"appnews":{}}',
      '{"appnews":{"newsitems":{}}}',
      doc(),
    ]) {
      assert.deepEqual(parseNews(text), [], text);
    }
  });

  it('keeps one release for a repeated title, and one for each channel of a version', () => {
    assert.equal(parseNews(doc(post(), post())).length, 1);
    const both = parseNews(doc(post(), post({ title: 'SteamOS 3.7.15 Beta', tags: ['betachannel'] })));
    assert.deepEqual(both.map((r) => r.id).sort(), [PAGE('steamos-3.7.15'), PAGE('steamos-3.7.15-beta')]);
  });

  it('gives the same id to a post whether it came from the API, the feed or the snapshot', () => {
    const [fromApi] = parseNews(doc(post()));
    const [fromFeed] = parseFeed(
      '<rss><channel><item><title>SteamOS 3.7.15</title><link>https://store.steampowered.com/news/app/1675200/view/1</link>' +
        '<pubDate>Sat, 10 Oct 2026 00:42:30 +0000</pubDate></item></channel></rss>',
    );
    assert.equal(fromApi.id, fromFeed.id);
  });
});

describe('parseFeed (the RSS form)', () => {
  const item = (title, link, guid = link, pubDate = 'Sat, 10 Oct 2026 00:42:30 +0000') =>
    `<item><title>${title}</title><link>${link}</link><pubDate>${pubDate}</pubDate>` +
    `<guid isPermaLink="true">${guid}</guid></item>`;
  const rss = (...items) => `<?xml version="1.0"?><rss version="2.0"><channel>${items.join('')}</channel></rss>`;
  const LINK = 'https://store.steampowered.com/news/app/1675200/view/1';

  it('skips every recorded Steam Client update', () => {
    assert.equal((RECORDED_RSS.match(/<item>/g) ?? []).length, 2);
    assert.deepEqual(parseFeed(RECORDED_RSS), []);
  });

  it('decides the stage from the title alone', () => {
    const releases = parseFeed(
      rss(
        item('SteamOS 3.7.13 Stable', LINK),
        item('SteamOS 3.7.14 Preview', `${LINK}2`, `${LINK}2`, 'Sun, 11 Oct 2026 03:08:11 +0000'),
        item('SteamOS 3.7.15', `${LINK}3`),
      ),
    );
    assert.deepEqual(
      releases.map((r) => [r.version, r.stage, r.date, r.url]),
      [
        ['3.7.14', 'beta', '2026-10-11T03:08:11Z', `${LINK}2`],
        ['3.7.13', 'release', '2026-10-10T00:42:30Z', LINK],
      ],
    );
  });

  it('skips a bad date, replaces a bad link host with the news page, and an empty or unreadable feed gives nothing', () => {
    const bad = parseFeed(
      rss(
        item('SteamOS 3.7.13 Stable', LINK, LINK, 'yesterday'),
        item('SteamOS 3.7.14 Stable', 'https://evil.example/x'),
        item('SteamOS 3.7.15 Stable', ''),
      ),
    );
    assert.deepEqual(bad.map((r) => r.version), ['3.7.14', '3.7.15']);
    assert.deepEqual(bad.map((r) => r.url), [NEWS_PAGE, NEWS_PAGE]);
    assert.deepEqual(parseFeed(rss()), []);
    assert.deepEqual(parseFeed(''), []);
    assert.deepEqual(parseFeed(null), []);
    assert.deepEqual(parseFeed('<html>nope</html>'), []);
  });
});

describe('parse', () => {
  it('reads either document and survives garbage', () => {
    assert.equal(parse(TITLES).length, 19);
    assert.deepEqual(parse(RECORDED_JSON), []);
    assert.deepEqual(parse(RECORDED_RSS), []);
    assert.deepEqual(parse(`  \n${doc(post())}`).map((r) => r.version), ['3.7.15']);
    assert.deepEqual(parse(''), []);
    assert.deepEqual(parse(undefined), []);
  });
});
