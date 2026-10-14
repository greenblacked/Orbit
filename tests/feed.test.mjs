// Tests for the release feeds: /api/feed.atom (Atom) and /api/feed.json (JSON Feed 1.1).
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import apple from '../deploy/sources/apple.js';
import { allowedLink, entryLink, MAX_ENTRIES, xmlEscape } from '../deploy/feeds.js';
import { createWorker } from '../deploy/worker.js';
import {
  fakeCtx,
  fakeEnv,
  ORIGIN,
  SNAPSHOT,
  state,
  useHarness,
} from './support/harness.mjs';

const worker = createWorker([apple]);
const OFF_ZONE = 'https://orbit.acct.workers.dev';
const call = (path, env = fakeEnv(), init = {}, origin = ORIGIN) =>
  worker.fetch(new Request(origin + path, init), env, fakeCtx());
// Off a live host the Worker answers from the snapshot alone, so a test controls every release.
const offZone = (path, releases, init = {}) =>
  call(path, fakeEnv({ ...SNAPSHOT, releases }), init, OFF_ZONE);

const release = (over) => ({
  ...SNAPSHOT.releases[0],
  ...over,
  id: over.id,
  url: over.url ?? `https://developer.apple.com/news/releases/?id=${over.id}`,
});

const MIXED = [
  release({ id: 'a', family: 'iOS', stage: 'beta', beta: 2, date: '2026-10-05T18:00:00Z', title: 'iOS 27.2 beta 2' }),
  release({ id: 'b', family: 'iPadOS', stage: 'beta', beta: 2, date: '2026-10-05T17:00:00Z', title: 'iPadOS 27.2 beta 2' }),
  release({ id: 'c', family: 'iOS', stage: 'release', beta: null, date: '2026-09-15T17:00:00Z', title: 'iOS 27.1' }),
  release({ id: 'd', family: 'macOS', stage: 'rc', beta: 1, date: '2026-09-10T17:00:00Z', title: 'macOS 27.1 RC' }),
];

const entries = (atom) => atom.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
const titlesOf = (atom) => entries(atom).map((e) => /<title>([^<]*)<\/title>/.exec(e)[1]);

useHarness();

describe('/api/feed.atom', () => {
  it('is an RFC 4287 feed with the headers of an API response', async () => {
    const res = await call('/api/feed.atom');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/atom+xml; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    const body = await res.text();
    assert.ok(body.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"'));
    assert.match(body, /<id>https:\/\/orbit\.szolotov\.com\/api\/feed\.atom<\/id>/);
    assert.match(body, /<title>Release Orbit releases<\/title>/);
    assert.match(body, /<updated>\d{4}-\d\d-\d\dT[\d:.]+Z<\/updated>/);
    assert.match(body, /<link rel="self" type="application\/atom\+xml" href="https:\/\/orbit\.szolotov\.com\/api\/feed\.atom"\/>/);
    assert.match(body, /<author><name>Release Orbit<\/name><\/author>/);
    const all = entries(body);
    assert.ok(all.length > 1);
    for (const entry of all) {
      assert.match(entry, /<id>tag:orbit\.szolotov\.com,2026:release:[^<]+<\/id>/);
      assert.match(entry, /<title>[^<]+<\/title>/);
      assert.match(entry, /<link rel="alternate" type="text\/html" href="https:\/\/[^"]+"\/>/);
      assert.match(entry, /<published>\d{4}-[^<]+Z<\/published>/);
      assert.match(entry, /<updated>\d{4}-[^<]+Z<\/updated>/);
    }
    // Every entry id is distinct.
    const ids = all.map((e) => /<id>([^<]*)<\/id>/.exec(e)[1]);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('lists the newest first, and the feed is updated when its newest entry is', async () => {
    const body = await (await offZone('/api/feed.atom', MIXED)).text();
    assert.deepEqual(titlesOf(body), ['iOS 27.2 beta 2', 'iPadOS 27.2 beta 2', 'iOS 27.1', 'macOS 27.1 RC']);
    assert.match(body, /<subtitle>[^<]+<\/subtitle>\n<updated>2026-10-05T18:00:00\.000Z<\/updated>/);
  });

  it('answers an empty but valid feed when a filter matches nothing', async () => {
    const body = await (await offZone('/api/feed.atom?family=watchOS', MIXED)).text();
    assert.equal(entries(body).length, 0);
    assert.match(body, /<updated>[^<]+<\/updated>/);
    assert.ok(body.endsWith('</feed>\n'));
  });

  it('escapes hostile titles, ids and links so the document stays well formed', async () => {
    const hostile = release({
      id: 'x&<"1\'',
      title: '<script>alert("a" & \'b\')</script>\u0000\u0007',
      url: 'https://developer.apple.com/news/releases/?a=1&b=<2>',
      date: '2026-10-06T00:00:00Z',
    });
    const body = await (await offZone('/api/feed.atom', [hostile])).text();
    assert.ok(!body.includes('<script>'));
    assert.ok(body.includes('&lt;script&gt;alert(&quot;a&quot; &amp; &apos;b&apos;)&lt;/script&gt;'));
    assert.ok(!/[\u0000-\u0008]/.test(body));
    assert.ok(body.includes('?a=1&amp;b='));
    // Well formed at the character level: every & starts an entity, and no tag-like text remains
    // once the tags are removed.
    assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(body));
    assert.ok(!/[<>]/.test(body.replace(/<[^<>]*>/g, '')));
  });

  it('links to the vendor only on an allowed host, otherwise to the timeline row', async () => {
    const good = release({ id: 'good', date: '2026-10-06T00:00:00Z' });
    const evil = release({ id: 'evil one', url: 'https://evil.example/p', date: '2026-10-05T00:00:00Z' });
    const plain = release({ id: 'plain', url: 'http://developer.apple.com/p', date: '2026-10-04T00:00:00Z' });
    const body = await (await offZone('/api/feed.atom', [good, evil, plain])).text();
    const [a, b, c] = entries(body);
    assert.ok(a.includes('href="https://developer.apple.com/news/releases/?id=good"'));
    assert.ok(b.includes('href="https://orbit.szolotov.com/timeline/?id=evil%20one"'));
    assert.ok(!b.includes('evil.example'));
    assert.ok(c.includes('href="https://orbit.szolotov.com/timeline/?id=plain"'));
  });

  it('caps the feed at the newest MAX_ENTRIES releases', async () => {
    const many = Array.from({ length: MAX_ENTRIES + 25 }, (_, i) =>
      release({ id: `r${i}`, title: `R${i}`, date: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString() }),
    );
    const body = await (await offZone('/api/feed.atom', many)).text();
    const titles = titlesOf(body);
    assert.equal(titles.length, MAX_ENTRIES);
    assert.equal(titles[0], `R${MAX_ENTRIES + 24}`);
    assert.equal(titles.at(-1), 'R25');
  });

  it('skips a release with no readable date or id instead of failing', async () => {
    const body = await (await offZone('/api/feed.atom', [{ ...MIXED[0], date: 'nope' }, MIXED[2]])).text();
    assert.deepEqual(titlesOf(body), ['iOS 27.1']);
  });

  it('applies ?vendor=, ?family= and ?stage= and names them in the feed', async () => {
    const family = await (await offZone('/api/feed.atom?family=iOS', MIXED)).text();
    assert.deepEqual(titlesOf(family), ['iOS 27.2 beta 2', 'iOS 27.1']);
    assert.match(family, /<id>https:\/\/orbit\.szolotov\.com\/api\/feed\.atom\?family=iOS<\/id>/);
    assert.match(family, /<title>Release Orbit releases \(iOS\)<\/title>/);
    const stage = await (await offZone('/api/feed.atom?stage=rc', MIXED)).text();
    assert.deepEqual(titlesOf(stage), ['macOS 27.1 RC']);
    const both = await (await offZone('/api/feed.atom?stage=beta&family=iPadOS&vendor=apple', MIXED)).text();
    assert.deepEqual(titlesOf(both), ['iPadOS 27.2 beta 2']);
    // Fixed order in the id, however the query was written; & escaped in the markup.
    assert.ok(both.includes('<id>https://orbit.szolotov.com/api/feed.atom?vendor=apple&amp;family=iPadOS&amp;stage=beta</id>'));
  });

  for (const query of ['vendor=nope', 'vendor=', 'family=Symbian', 'family=', 'stage=alpha', 'stage=']) {
    for (const path of ['/api/feed.atom', '/api/feed.json']) {
      it(`answers 400 JSON for ${path}?${query}`, async () => {
        const res = await call(`${path}?${query}`);
        assert.equal(res.status, 400);
        assert.match(res.headers.get('content-type'), /^application\/json; charset=utf-8$/);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const body = await res.json();
        const name = query.split('=')[0];
        assert.equal(body.error, `unknown ${name}`);
        assert.ok(Array.isArray(body[{ vendor: 'vendors', family: 'families', stage: 'stages' }[name]]));
        assert.equal(state.upstream.calls.length, 0, 'nothing is fetched for a bad filter');
      });
    }
  }

  it('answers HEAD with the headers and no body, and refuses other methods', async () => {
    const head = await call('/api/feed.atom', fakeEnv(), { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'application/atom+xml; charset=utf-8');
    assert.equal(await head.text(), '');
    const post = await call('/api/feed.atom', fakeEnv(), { method: 'POST' });
    assert.equal(post.status, 405);
  });

  it('answers 503 when no release is available at all', async () => {
    const res = await call('/api/feed.atom', fakeEnv(null), {}, OFF_ZONE);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});

describe('/api/feed.json', () => {
  it('is a JSON Feed 1.1 document with the headers of an API response', async () => {
    const res = await offZone('/api/feed.json', MIXED);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/feed+json; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    const feed = await res.json();
    assert.equal(feed.version, 'https://jsonfeed.org/version/1.1');
    assert.equal(feed.title, 'Release Orbit releases');
    assert.equal(feed.home_page_url, 'https://orbit.szolotov.com/timeline/');
    assert.equal(feed.feed_url, 'https://orbit.szolotov.com/api/feed.json');
    assert.deepEqual(feed.items.map((item) => item.title), MIXED.map((r) => r.title));
    const first = feed.items[0];
    assert.equal(first.id, 'tag:orbit.szolotov.com,2026:release:a');
    assert.equal(first.url, 'https://developer.apple.com/news/releases/?id=a');
    assert.equal(first.date_published, '2026-10-05T18:00:00.000Z');
    assert.deepEqual(first.tags, ['iOS', 'beta']);
    assert.equal(typeof first.content_text, 'string');
  });

  it('carries the same entries and filters as the Atom feed', async () => {
    const atom = titlesOf(await (await offZone('/api/feed.atom?stage=beta', MIXED)).text());
    const feed = await (await offZone('/api/feed.json?stage=beta', MIXED)).json();
    assert.deepEqual(feed.items.map((item) => item.title), atom);
    assert.equal(feed.feed_url, 'https://orbit.szolotov.com/api/feed.json?stage=beta');
  });

  it('keeps hostile text as data and links a disallowed host to the timeline', async () => {
    const hostile = release({
      id: 'h"</script>',
      title: '<b>"x" & y</b>',
      url: 'javascript:alert(1)',
      date: '2026-10-06T00:00:00Z',
    });
    const res = await offZone('/api/feed.json', [hostile]);
    const feed = JSON.parse(await res.text());
    assert.equal(feed.items[0].title, '<b>"x" & y</b>');
    assert.equal(feed.items[0].url, 'https://orbit.szolotov.com/timeline/?id=h%22%3C%2Fscript%3E');
  });

  it('answers from the snapshot alone off the live hosts, without the cache or a vendor fetch', async () => {
    const used = [];
    for (const name of ['match', 'put', 'delete']) {
      const original = state.cache[name].bind(state.cache);
      state.cache[name] = (...args) => {
        used.push(name);
        return original(...args);
      };
    }
    const res = await offZone('/api/feed.json', MIXED);
    assert.equal(res.status, 200);
    assert.equal(state.upstream.calls.length, 0);
    assert.deepEqual(used, []);
  });

  it('fetches live on a live host', async () => {
    const feed = await (await call('/api/feed.json')).json();
    assert.ok(feed.items.length > 1);
    assert.equal(state.upstream.calls.length, 1);
    assert.ok(feed.items.every((item) => item.id.startsWith('tag:orbit.szolotov.com,2026:release:')));
  });
});

describe('feed helpers', () => {
  it('allows only https links on the vendor hosts', () => {
    assert.equal(allowedLink('apple', 'https://developer.apple.com/x'), true);
    assert.equal(allowedLink('apple', 'http://developer.apple.com/x'), false);
    assert.equal(allowedLink('apple', 'https://developer.apple.com.evil.example/'), false);
    assert.equal(allowedLink('apple', 'https://mikrotik.com/x'), false);
    assert.equal(allowedLink('mikrotik', 'https://mikrotik.com/x'), true);
    assert.equal(allowedLink('nobody', 'https://developer.apple.com/x'), false);
    assert.equal(allowedLink('apple', 'not a url'), false);
    assert.equal(allowedLink('apple', undefined), false);
  });

  it('falls back to the timeline for an id with reserved characters', () => {
    assert.equal(
      entryLink({ id: 'a b&c', vendor: 'apple', url: 'https://evil.example/' }),
      'https://orbit.szolotov.com/timeline/?id=a%20b%26c',
    );
  });

  it('escapes the five XML characters and drops forbidden control characters', () => {
    assert.equal(xmlEscape(`<a href="x">&'</a>\u0001\u000b`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
    assert.equal(xmlEscape(null), '');
    assert.equal(xmlEscape('tab\there\nok'), 'tab\there\nok');
  });
});
