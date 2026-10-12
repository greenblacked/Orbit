// Tests for the source registry and the multi-source Worker: one failing source keeps the
// others, `?vendor=` filters, and a release always carries the vendor and source it came from.
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FAMILIES } from '../deploy/families.js';
import android from '../deploy/sources/android.js';
import apple from '../deploy/sources/apple.js';
import mikrotik from '../deploy/sources/mikrotik.js';
import { isSource, SOURCES, vendorsOf } from '../deploy/sources/index.js';
import steamos from '../deploy/sources/steamos.js';
import windows from '../deploy/sources/windows.js';
import { createWorker, DEFAULT_ACCEPT } from '../deploy/worker.js';
import {
  advance,
  ago,
  APPLE_ID,
  cacheUrl,
  FEED_URL,
  fakeCtx,
  fakeEnv,
  feedResponse,
  ORIGIN,
  seed,
  SNAPSHOT,
  state,
  stubUpstream,
  useHarness,
} from './support/harness.mjs';

// A second vendor, with a feed of its own: lines of "id date version".
const ACME_URL = 'https://feed.example/releases.txt';
const ACME_ID = 'acme-feed';
const acmeRelease = (id, date, version) => ({
  id,
  vendor: 'acme',
  family: 'Slate',
  version,
  major: Number(version.split('.')[0]),
  stage: 'release',
  beta: null,
  build: `B${version}`,
  title: `Slate ${version}`,
  date,
  url: `https://feed.example/${id}`,
  source: ACME_ID,
});
const acme = {
  id: ACME_ID,
  vendor: 'acme',
  urls: [ACME_URL],
  parse: (text) =>
    text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, date, version] = line.split(' ');
        return acmeRelease(id, date, version);
      }),
};
const ACME_FEED = 'a1 2026-10-04T10:00:00Z 3.1\na2 2026-10-06T10:00:00Z 3.2\n';

const worker = createWorker([apple, acme]);
const call = (path, env = fakeEnv(), ctx = fakeCtx(), init = {}) =>
  worker.fetch(new Request(ORIGIN + path, init), env, ctx);
const getJson = async (path, env) => (await call(path, env)).json();

// Route the upstream by URL; a missing route is an Apple-style outage.
function routes(table) {
  stubUpstream((url) => {
    const handler = table[url];
    return handler ? handler() : new Response('nope', { status: 503 });
  });
}
const bothUp = () =>
  routes({ [FEED_URL]: () => feedResponse(), [ACME_URL]: () => new Response(ACME_FEED) });
const urlsAsked = () => state.upstream.calls.map((c) => c.url);
const vendors = (body) => [...new Set(body.releases.map((r) => r.vendor))].sort();

useHarness();

describe('the registry', () => {
  it('holds well-formed adapters with unique ids', () => {
    assert.ok(SOURCES.length >= 1);
    assert.ok(SOURCES.every(isSource));
    assert.equal(new Set(SOURCES.map((s) => s.id)).size, SOURCES.length);
    assert.ok(SOURCES.includes(apple));
    assert.deepEqual([...vendorsOf(SOURCES)].sort(), ['apple', 'google', 'microsoft', 'mikrotik', 'valve']);
    assert.ok(SOURCES.includes(mikrotik));
    assert.ok(SOURCES.includes(android));
    assert.ok(SOURCES.includes(windows));
    assert.ok(SOURCES.includes(steamos));
  });

  it('only lists https URLs, and the families of its own vendor', () => {
    for (const source of SOURCES) {
      assert.ok(source.urls.every((url) => url.startsWith('https://')), source.id);
      assert.ok(FAMILIES.some((family) => family.vendor === source.vendor), source.id);
    }
  });

  it('refuses a malformed adapter', () => {
    for (const bad of [
      null,
      {},
      { id: 'x', vendor: 'v', urls: [], parse: () => [] },
      { id: 'x', vendor: 'v', urls: ['http://insecure.example/'], parse: () => [] },
      { id: 'x', vendor: 'v', urls: ['https://ok.example/'] },
      { id: '', vendor: 'v', urls: ['https://ok.example/'], parse: () => [] },
    ]) {
      assert.equal(isSource(bad), false);
    }
    assert.equal(isSource(acme), true);
  });

  it('drops a malformed adapter from a Worker instead of failing', async () => {
    const lenient = createWorker([apple, { id: 'broken' }]);
    const res = await lenient.fetch(new Request(`${ORIGIN}/api/releases.json`), fakeEnv(), fakeCtx());
    assert.equal(res.status, 200);
    assert.equal((await res.json()).source, APPLE_ID);
  });
});

describe('a Worker with two sources', () => {
  it('fetches each source once, merges them and caches each under its own key', async () => {
    bothUp();
    const body = await getJson('/api/releases.json');
    assert.deepEqual(urlsAsked().sort(), [ACME_URL, FEED_URL].sort());
    assert.equal(body.source, `${APPLE_ID},${ACME_ID}`);
    assert.equal(body.stale, false);
    assert.equal(body.releases.length, 29 + 2);
    assert.deepEqual(vendors(body), ['acme', 'apple']);
    for (let i = 1; i < body.releases.length; i += 1) {
      assert.ok(body.releases[i - 1].date >= body.releases[i].date);
    }
    assert.deepEqual([...state.cache.store.keys()].sort(), [cacheUrl(ACME_ID), cacheUrl(APPLE_ID)].sort());
  });

  it('stamps the vendor and source of the adapter on what it returns', async () => {
    const liar = {
      ...acme,
      parse: (text) => acme.parse(text).map((r) => ({ ...r, vendor: 'apple', source: APPLE_ID })),
    };
    routes({ [ACME_URL]: () => new Response(ACME_FEED) });
    const only = createWorker([liar]);
    const res = await only.fetch(new Request(`${ORIGIN}/api/releases.json`), fakeEnv(null), fakeCtx());
    const body = await res.json();
    assert.deepEqual(vendors(body), ['acme']);
    assert.ok(body.releases.every((r) => r.source === ACME_ID));
  });

  it('serves the sources that work when one is down, marked stale', async () => {
    routes({ [FEED_URL]: () => feedResponse() }); // ACME_URL answers 503
    const res = await call('/api/releases.json');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.releases.length, 29);
    assert.deepEqual(vendors(body), ['apple']);
    assert.equal(body.source, APPLE_ID);
    assert.equal(body.stale, true, 'something is missing, so the answer says so');
  });

  it('keeps the others when one source throws, or returns something unreadable', async () => {
    const throwing = { ...acme, parse: () => { throw new Error('layout changed'); } };
    const empty = { ...acme, id: 'empty-feed', parse: () => [] };
    routes({
      [FEED_URL]: () => feedResponse(),
      [ACME_URL]: () => new Response(ACME_FEED),
    });
    for (const broken of [throwing, empty]) {
      const w = createWorker([broken, apple]);
      const res = await w.fetch(new Request(`${ORIGIN}/api/releases.json`), fakeEnv(), fakeCtx());
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.releases.length, 29);
      assert.deepEqual(vendors(body), ['apple']);
      state.cache.store.clear();
    }
  });

  it('falls back to the snapshot for the failing source only', async () => {
    const snapshot = {
      ...SNAPSHOT,
      source: `${APPLE_ID},${ACME_ID}`,
      releases: [...SNAPSHOT.releases, acmeRelease('a0', '2026-09-01T10:00:00Z', '3.0')],
    };
    routes({ [FEED_URL]: () => feedResponse() }); // acme is down
    const body = await getJson('/api/releases.json', fakeEnv(snapshot));
    assert.equal(body.releases.length, 29 + 1);
    assert.deepEqual(vendors(body), ['acme', 'apple']);
    assert.equal(body.stale, true);
    assert.equal(body.snapshot, true, 'one of the two parts is the bundled copy');
    assert.equal(body.releases.find((r) => r.vendor === 'acme').id, 'a0');
    // Only the live source was cached: a fallback is never cached as if it were live. The
    // failing one holds just a back-off marker with no releases.
    assert.deepEqual([...state.cache.store.keys()].sort(), [cacheUrl(ACME_ID), cacheUrl(APPLE_ID)].sort());
    const marker = await state.cache.store.get(cacheUrl(ACME_ID)).res.clone().json();
    assert.deepEqual([marker.negative, marker.releases], [true, []]);
  });

  it('gives each source its own back-off and refresh', async () => {
    await seed(ago(30 * 60 * 1000)); // apple: past its fresh window
    await seed(ago(60 * 1000), {}, ACME_ID, [acmeRelease('a1', '2026-10-04T10:00:00Z', '3.1')]);
    routes({ [FEED_URL]: () => new Response('nope', { status: 503 }) });
    const ctx = fakeCtx();
    await call('/api/releases.json', fakeEnv(), ctx);
    await ctx.settle();
    // Only the stale source was refreshed, and only it carries the failure mark.
    assert.deepEqual(urlsAsked(), [FEED_URL]);
    const body = await getJson('/api/releases.json');
    assert.deepEqual(vendors(body), ['acme', 'apple']);
    assert.equal(body.stale, true);
    const health = await getJson('/api/health');
    const byId = Object.fromEntries(health.sources.map((s) => [s.id, s]));
    assert.equal(byId[APPLE_ID].stale, true);
    assert.equal(byId[ACME_ID].stale, false);
    assert.deepEqual(urlsAsked(), [FEED_URL], 'nobody asked again inside the back-off');
    advance(6 * 60 * 1000);
    routes({ [FEED_URL]: () => feedResponse(), [ACME_URL]: () => new Response(ACME_FEED) });
    const ctx2 = fakeCtx();
    await call('/api/releases.json', fakeEnv(), ctx2);
    await ctx2.settle();
    assert.ok(urlsAsked().includes(FEED_URL));
  });

  it('answers 503 only when every source has nothing', async () => {
    routes({});
    const res = await call('/api/releases.json', fakeEnv(null));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const health = await call('/api/health', fakeEnv(null));
    assert.equal(health.status, 503);
    const body = await health.json();
    assert.equal(body.ok, false);
    assert.deepEqual(body.sources.map((s) => [s.id, s.ok]), [[APPLE_ID, false], [ACME_ID, false]]);
  });

  it('reports each source in /api/health, and ok while one still works', async () => {
    routes({ [FEED_URL]: () => feedResponse() });
    const body = await getJson('/api/health');
    assert.equal(body.ok, true);
    assert.equal(body.stale, true);
    assert.equal(body.count, 29);
    const byId = Object.fromEntries(body.sources.map((s) => [s.id, s]));
    assert.deepEqual([byId[APPLE_ID].ok, byId[APPLE_ID].count], [true, 29]);
    assert.deepEqual([byId[ACME_ID].ok, byId[ACME_ID].count, byId[ACME_ID].fetchedAt], [false, 0, null]);
  });
});

describe('the vendor filter', () => {
  it('returns only the releases of that vendor, and asks only its sources', async () => {
    bothUp();
    const apples = await getJson('/api/releases.json?vendor=apple');
    assert.deepEqual(vendors(apples), ['apple']);
    assert.equal(apples.source, APPLE_ID);
    assert.equal(apples.releases.length, 29);
    assert.deepEqual(urlsAsked(), [FEED_URL]);

    const acmes = await getJson('/api/releases.json?vendor=acme');
    assert.deepEqual(vendors(acmes), ['acme']);
    assert.equal(acmes.releases.length, 2);
    assert.deepEqual(urlsAsked().sort(), [ACME_URL, FEED_URL].sort());
  });

  it('returns every vendor without a filter', async () => {
    bothUp();
    assert.deepEqual(vendors(await getJson('/api/releases.json')), ['acme', 'apple']);
  });

  it('is not blanked by a failing source of another vendor', async () => {
    routes({ [FEED_URL]: () => feedResponse() }); // acme is down
    const body = await getJson('/api/releases.json?vendor=apple');
    assert.equal(body.releases.length, 29);
    assert.equal(body.stale, false, 'the other vendor is not part of this answer');
  });

  it('answers 400 with the known vendors for an unknown or empty one', async () => {
    bothUp();
    for (const query of ['vendor=nope', 'vendor=', 'vendor=Apple', 'vendor=apple%00']) {
      const res = await call(`/api/releases.json?${query}`);
      assert.equal(res.status, 400, query);
      assert.match(res.headers.get('content-type'), /^application\/json/);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const body = await res.json();
      assert.equal(body.error, 'unknown vendor');
      assert.deepEqual(body.vendors, ['apple', 'acme']);
    }
    assert.equal(state.upstream.calls.length, 0, 'a bad filter never reaches a source');
  });

  it('works on HEAD and ignores unrelated query parameters', async () => {
    bothUp();
    const head = await call('/api/releases.json?vendor=apple', fakeEnv(), fakeCtx(), { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const other = await getJson('/api/releases.json?x=1');
    assert.deepEqual(vendors(other), ['acme', 'apple']);
  });
});

describe('the Accept header of an upstream request', () => {
  const askedWith = (url) => state.upstream.calls.find((c) => c.url === url).init.headers.accept;
  const page = {
    id: 'html-page',
    vendor: 'acme',
    accept: 'text/html',
    urls: ['https://feed.example/page.html'],
    parse: () => [acmeRelease('p1', '2026-10-05T10:00:00Z', '4.0')],
  };

  it('is the feeds-and-text default unless the adapter sets its own', async () => {
    const mixed = createWorker([acme, page]);
    stubUpstream(() => new Response(ACME_FEED));
    const res = await mixed.fetch(new Request(`${ORIGIN}/api/releases.json`), fakeEnv(), fakeCtx());
    assert.equal(res.status, 200);
    assert.equal(askedWith(ACME_URL), DEFAULT_ACCEPT);
    assert.equal(askedWith('https://feed.example/page.html'), 'text/html');
  });

  it('keeps plain text in the default, for the MikroTik NEWEST files', () => {
    assert.match(DEFAULT_ACCEPT, /text\/plain/);
    assert.equal(mikrotik.accept, undefined);
  });

  it('asks for HTML on the two HTML sources and for nothing special elsewhere', () => {
    for (const source of [android, windows]) {
      assert.match(source.accept, /^text\/html/, source.id);
      assert.ok(isSource(source), source.id);
    }
    for (const source of [apple, mikrotik, steamos]) {
      assert.equal(source.accept, undefined, source.id);
    }
  });

  it('refuses an adapter whose accept is not a non-empty string', () => {
    for (const accept of ['', 7, null, ['text/html']]) {
      assert.equal(isSource({ ...acme, accept }), false, String(accept));
    }
    assert.equal(isSource({ ...acme, accept: 'text/html' }), true);
  });
});
