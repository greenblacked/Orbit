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
  summaryOfTitle,
  titlePattern,
  linkOf,
} from '../deploy/sources/steamos.js';

const read = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/valve/${name}`, import.meta.url)), 'utf8');
const RECORDED_JSON = read('getnewsforapp.json');
const RECORDED_RSS = read('news.rss');
const TITLES = read('getnewsforapp-steamos-titles.json');
const PAGE = (slug) => `${NEWS_PAGE}#${slug}`;

// The clock of the recorded data: the day after the probe. Every test passes it (parse() takes
// it as its third argument) so none depends on the real clock; the Worker passes none.
const NOW = Date.UTC(2026, 9, 13);
const news = (text, now = NOW) => parseNews(text, now);
const feed = (text, now = NOW) => parseFeed(text, now);

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

describe('summaryOfTitle', () => {
  it('gives the words after the version, the channel and the build', () => {
    assert.equal(summaryOfTitle('SteamOS 3.7.13 Stable: Deck update'), 'Deck update');
    assert.equal(summaryOfTitle('SteamOS 3.8.1 Preview (20250522.1) - Fan curve fixes'), 'Fan curve fixes');
    assert.equal(summaryOfTitle('SteamOS 3.7.13: Beta, Docking fixes'), 'Docking fixes');
    assert.equal(summaryOfTitle('SteamOS 3.7.13 Docking fixes'), 'Docking fixes');
    assert.equal(summaryOfTitle('SteamOS 3.8.1 Preview 20250522.1 - Fan fixes'), 'Fan fixes');
  });

  it('gives nothing for a title that is only the name, version, channel and build', () => {
    for (const title of [
      'SteamOS 3.8.28',
      'SteamOS 3.8.28 Beta',
      'SteamOS 3.9.1 Preview',
      'SteamOS 3.8.1 Preview (20250522.1)',
      'SteamOS 3.8.1 Preview 20250522.1',
      'SteamOS 3.7.13 Stable:',
      'Steam Client Update',
      '',
      undefined,
    ]) {
      assert.equal(summaryOfTitle(title), '', String(title));
    }
  });
});

describe('parseNews', () => {
  it('skips every recorded Steam Client update', () => {
    assert.deepEqual(news(RECORDED_JSON), []);
  });

  it('keeps all 19 real SteamOS posts of the probe, newest first, without a gid or a link', () => {
    const releases = news(TITLES);
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

  it('keeps a headline in the title as the summary, and no summary for the recorded titles', () => {
    assert.ok(news(TITLES).every((r) => !('summary' in r)));
    const [headline] = news(doc(post({ title: 'SteamOS 3.7.15 Stable: Deck update' })));
    assert.equal(headline.summary, 'Deck update');
    assert.equal(headline.title, 'SteamOS 3.7.15 Stable: Deck update');
    const [rss] = parseFeed(
      '<rss><channel><item><title>SteamOS 3.7.15 Stable: Deck update</title>' +
        '<pubDate>Fri, 09 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>',
      NOW,
    );
    assert.equal(rss.summary, 'Deck update');
  });

  it('maps the real channel tags: stable wins, beta and preview are betas', () => {
    const stage = Object.fromEntries(news(TITLES).map((r) => [r.title, r.stage]));
    assert.equal(stage['SteamOS 3.8.28'], 'release');
    assert.equal(stage['SteamOS 3.8.12'], 'release'); // stable, beta and preview tags together
    assert.equal(stage['SteamOS 3.8.28 Beta'], 'beta');
    assert.equal(stage['SteamOS 3.9.1 Preview'], 'beta'); // previewchannel alone
    assert.equal(stage['SteamOS 3.8.21 Beta'], 'beta'); // with moderation tags in between
  });

  it('keeps a link on the Steam hosts and replaces any other with the news page', () => {
    const good = 'https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1';
    assert.equal(news(doc(post({ url: good })))[0].url, good);
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
      assert.equal(news(doc(post({ url })))[0].url, NEWS_PAGE, String(url));
    }
  });

  it('never keeps the post text', () => {
    const text = news(doc(post({ contents: 'Fixed a secret thing', author: 'someone' })));
    assert.ok(!JSON.stringify(text).includes('secret'));
    assert.ok(!JSON.stringify(text).includes('someone'));
  });

  it('skips malformed entries and keeps the good ones', () => {
    const releases = news(
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
      assert.deepEqual(news(text), [], text);
    }
  });

  it('keeps one release for a repeated title, and one for each channel of a version', () => {
    assert.equal(news(doc(post(), post())).length, 1);
    const both = news(doc(post(), post({ title: 'SteamOS 3.7.15 Beta', tags: ['betachannel'] })));
    assert.deepEqual(both.map((r) => r.id).sort(), [PAGE('steamos-3.7.15'), PAGE('steamos-3.7.15-beta')]);
  });

  it('gives the same id to a post whether it came from the API, the feed or the snapshot', () => {
    const title = 'SteamOS 3.7.15 Stable';
    const apiReleases = news(doc(post({ title })));
    assert.equal(apiReleases.length, 1);
    const feedReleases = feed(
      '<rss><channel><item><title>SteamOS 3.7.15 Stable</title><link>https://store.steampowered.com/news/app/1675200/view/1</link>' +
        '<pubDate>Sat, 10 Oct 2026 00:42:30 +0000</pubDate></item></channel></rss>',
    );
    assert.equal(feedReleases.length, 1);
    assert.equal(apiReleases[0].id, feedReleases[0].id);
    assert.equal(apiReleases[0].id, PAGE('steamos-3.7.15-stable'));
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
    assert.deepEqual(feed(RECORDED_RSS), []);
  });

  it('decides the stage from the title alone', () => {
    const releases = feed(
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
    const bad = feed(
      rss(
        item('SteamOS 3.7.13 Stable', LINK, LINK, 'yesterday'),
        item('SteamOS 3.7.14 Stable', 'https://evil.example/x'),
        item('SteamOS 3.7.15 Stable', ''),
      ),
    );
    assert.deepEqual(bad.map((r) => r.version), ['3.7.14', '3.7.15']);
    assert.deepEqual(bad.map((r) => r.url), [NEWS_PAGE, NEWS_PAGE]);
    assert.deepEqual(feed(rss()), []);
    assert.deepEqual(feed(''), []);
    assert.deepEqual(feed(null), []);
    assert.deepEqual(feed('<html>nope</html>'), []);
  });
});

describe('parse', () => {
  it('reads the news JSON and survives garbage', () => {
    assert.equal(parse(TITLES, undefined, NOW).length, 19);
    assert.deepEqual(parse(RECORDED_JSON, undefined, NOW), []);
    assert.deepEqual(parse(RECORDED_RSS, undefined, NOW), []);
    assert.deepEqual(parse(`  \n${doc(post())}`, undefined, NOW).map((r) => r.version), ['3.7.15']);
    assert.deepEqual(parse('', undefined, NOW), []);
    assert.deepEqual(parse(undefined, undefined, NOW), []);
  });

  it('ignores the url the Worker passes as the second argument', () => {
    assert.deepEqual(steamos.parse(TITLES, NEWS_URL, NOW), steamos.parse(TITLES, undefined, NOW));
    assert.deepEqual(steamos.parse(doc(post(), post({ date: 4102444800, title: 'SteamOS 9.9.9' })), NEWS_URL, NOW).map((r) => r.version), ['3.7.15']);
  });

  it('does not read RSS, so a body of unclosed <item> tags costs nothing', () => {
    const started = performance.now();
    assert.deepEqual(parse('<item>'.repeat(200000)), []);
    assert.deepEqual(parse('<rss><channel><item><title>SteamOS 3.7.13 Stable</title></item></channel></rss>'), []);
    assert.ok(performance.now() - started < 2000);
  });
});

describe('the bounds on what is emitted', () => {
  it('refuses a post dated more than a day ahead of the clock', () => {
    const releases = news(
      doc(
        post({ title: 'SteamOS 3.7.16', date: 4102444800 }), // 2100-01-01
        post({ title: 'SteamOS 3.7.15', date: Math.floor(NOW / 1000) + 3600 }),
      ),
    );
    assert.deepEqual(releases.map((r) => r.version), ['3.7.15']);
    const far = '<item><title>SteamOS 3.7.16 Stable</title><pubDate>Fri, 01 Jan 2100 00:00:00 +0000</pubDate></item>';
    assert.deepEqual(feed(`<rss><channel>${far}</channel></rss>`), []);
  });

  it('keeps every SteamOS post however old, with no time window', () => {
    assert.equal(news(TITLES).length, 19);
    const later = Date.UTC(2030, 3, 1);
    assert.equal(news(TITLES, later).length, 19);
    assert.equal(news(TITLES, later)[0].version, '3.9.2');
  });

  it('keeps old posts next to new ones', () => {
    const day = 86400;
    const base = Math.floor(NOW / 1000);
    const releases = news(
      doc(
        post({ title: 'SteamOS 3.7.16', date: base - 10 * day }),
        post({ title: 'SteamOS 3.7.15', date: base - 150 * day }),
        post({ title: 'SteamOS 3.7.14', date: base - 200 * day }),
      ),
    );
    assert.deepEqual(releases.map((r) => r.version), ['3.7.16', '3.7.15', '3.7.14']);
  });
});

describe('link and title hardening', () => {
  it('rebuilds a link from its host and path, and refuses credentials and a port', () => {
    const path = '/news/app/1675200/view/1';
    assert.equal(linkOf(`https://store.steampowered.com${path}?x=1#y`), `https://store.steampowered.com${path}`);
    assert.equal(linkOf(`https://user:pw@store.steampowered.com${path}`), NEWS_PAGE);
    assert.equal(linkOf(`https://store.steampowered.com:8443${path}`), NEWS_PAGE);
    assert.equal(parseNews(doc(post({ url: `https://user:pw@store.steampowered.com${path}` })), NOW)[0].url, NEWS_PAGE);
  });

  it('matches a family name with regular-expression characters literally', () => {
    const re = titlePattern(['SteamOS (Deck)', 'Steam+']);
    assert.equal(re.exec('SteamOS (Deck) 3.7.13')?.[1], 'SteamOS (Deck)');
    assert.equal(re.exec('Steam+ 1.2')?.[1], 'Steam+');
    assert.equal(re.exec('SteamOS Deck 3.7.13'), null);
    assert.equal(re.exec('Steam 1.2'), null);
    assert.equal(titlePattern(['SteamOS']).exec('SteamOS 3.7.13')?.[2], '3.7.13');
  });
});
