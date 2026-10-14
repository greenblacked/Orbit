// Tests for the releases API Worker over the Apple source (the other adapters have their own tests).
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, mock } from 'node:test';

import apple from '../deploy/sources/apple.js';
import { createWorker, LIVE_HOSTS } from '../deploy/worker.js';
import {
  advance,
  ago,
  APPLE_ID,
  cacheUrl,
  FEED,
  FEED_URL,
  fakeCtx,
  fakeEnv,
  feedResponse,
  HEADERS_FILE,
  ORIGIN,
  rss,
  seed,
  SNAPSHOT,
  state,
  stubUpstream,
  useHarness,
} from './support/harness.mjs';

// The shipped Apple source alone: other vendors are covered by their own tests.
const worker = createWorker([apple]);
const call = (path, env, ctx = fakeCtx(), init = {}) =>
  worker.fetch(new Request(ORIGIN + path, init), env, ctx);

useHarness();

const CACHE_URL = cacheUrl(APPLE_ID);

describe('the Worker: /api/releases.json', () => {
  it('fetches live when nothing is cached, merges the snapshot and caches the result', async () => {
    const env = fakeEnv();
    const res = await call('/api/releases.json', env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.stale, false);
    assert.equal(body.snapshot, false);
    assert.equal(body.source, APPLE_ID);
    assert.equal(body.releases.length, 29); // 28 from the feed + 1 only the snapshot has
    assert.equal(body.releases.at(-1).id, SNAPSHOT.releases[0].id);
    assert.equal(state.upstream.calls.length, 1);
    assert.equal(state.upstream.calls[0].url, FEED_URL);
    assert.match(
      state.upstream.calls[0].init.headers['user-agent'],
      /^orbit \(\+https:\/\/orbit\.szolotov\.com\)$/,
    );
    assert.ok(state.upstream.calls[0].init.signal instanceof AbortSignal);
    assert.equal(state.cache.store.size, 1);
  });

  it('serves a fresh cached copy without touching Apple', async () => {
    await seed(ago(60 * 1000));
    const res = await call('/api/releases.json', fakeEnv());
    assert.equal(res.status, 200);
    assert.equal((await res.json()).stale, false);
    assert.equal(state.upstream.calls.length, 0);
  });

  it('serves a copy past the fresh window at once and refreshes in the background', async () => {
    await seed(ago(30 * 60 * 1000));
    const ctx = fakeCtx();
    let answer;
    stubUpstream(() => new Promise((resolve) => (answer = resolve))); // Apple is slow
    const res = await call('/api/releases.json', fakeEnv(), ctx);
    const body = await res.json();
    assert.equal(body.releases.length, 1); // the old copy, served without waiting
    assert.equal(body.stale, false);
    // The refresh with its failure mark, and the shared fetch itself.
    assert.equal(ctx.pending.length, 2);
    assert.equal(state.upstream.calls.length, 1);

    answer(feedResponse());
    await ctx.settle();
    const next = await call('/api/releases.json', fakeEnv());
    assert.equal((await next.json()).releases.length, 29);
  });

  it('keeps a release that has left the feed since the cached copy was fetched', async () => {
    const gone = {
      ...SNAPSHOT.releases[0],
      id: 'https://developer.apple.com/news/releases/?id=gone1',
      url: 'https://developer.apple.com/news/releases/?id=gone1',
      title: 'iOS 25.9 (22Z1)',
      date: '2025-06-01T17:00:00Z',
    };
    await seed(ago(30 * 60 * 1000), {}, APPLE_ID, [gone]); // in the cache, not in feed or snapshot
    const ctx = fakeCtx();
    await call('/api/releases.json', fakeEnv(), ctx);
    await ctx.settle();
    const body = await (await call('/api/releases.json', fakeEnv())).json();
    assert.equal(body.stale, false);
    const ids = body.releases.map((release) => release.id);
    assert.ok(ids.includes(gone.id), 'the cached release survives the refresh');
    assert.ok(ids.includes(SNAPSHOT.releases[0].id), 'and so does the snapshot one');
    assert.equal(body.releases.length, 30); // 28 from the feed + snapshot + cached
  });

  it('shares one background refresh between concurrent requests', async () => {
    await seed(ago(30 * 60 * 1000));
    let answer;
    stubUpstream(() => new Promise((resolve) => (answer = resolve)));
    const ctxs = [fakeCtx(), fakeCtx(), fakeCtx()];
    await Promise.all(ctxs.map((ctx) => call('/api/releases.json', fakeEnv(), ctx)));
    assert.equal(state.upstream.calls.length, 1);
    answer(feedResponse());
    await Promise.all(ctxs.map((ctx) => ctx.settle()));
    assert.equal(state.upstream.calls.length, 1);
  });

  it('keeps the last live copy for days, not only for the fresh and max-age windows', async () => {
    await call('/api/releases.json', fakeEnv()); // live fetch at T0
    const stored = state.cache.store.get(CACHE_URL);
    assert.ok(stored.maxAge >= 7 * 24 * 3600, `cached for only ${stored.maxAge} s`);
  });

  it('serves the last live copy with stale true when Apple stays down past 24 hours', async () => {
    const first = await (await call('/api/releases.json', fakeEnv())).json();
    assert.equal(first.releases.length, 29);
    advance(3600 * 1000);
    stubUpstream(() => new Response('nope', { status: 503 }));
    advance(48 * 3600 * 1000);
    const res = await call('/api/releases.json', fakeEnv());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.stale, true);
    assert.equal(body.snapshot, false);
    assert.equal(body.releases.length, 29, 'the live copy, not the older snapshot');
    assert.equal(body.fetchedAt, first.fetchedAt);
    assert.equal('failedAt' in body, false);
  });

  it('serves the last cached copy with stale true when Apple fails', async () => {
    await seed(ago(48 * 3600 * 1000)); // past the hard max, so it must go live first
    stubUpstream(() => new Response('nope', { status: 503 }));
    const res = await call('/api/releases.json', fakeEnv());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.stale, true);
    assert.equal(body.releases.length, 1);
  });

  it('marks the copy stale after a failed refresh and backs off before asking again', async () => {
    await seed(ago(30 * 60 * 1000));
    stubUpstream(() => new Response('nope', { status: 503 }));
    const ctx = fakeCtx();
    const first = await (await call('/api/releases.json', fakeEnv(), ctx)).json();
    assert.equal(first.stale, false); // nothing has failed yet when this is served
    await ctx.settle();
    assert.equal(state.upstream.calls.length, 1);

    // Within the back-off window nobody asks Apple, and the answer says so.
    for (const path of ['/api/releases.json', '/api/health', '/api/health']) {
      const ctx2 = fakeCtx();
      const res = await call(path, fakeEnv(), ctx2);
      assert.equal((await res.json()).stale, true, path);
      assert.equal(ctx2.pending.length, 0);
    }
    assert.equal(state.upstream.calls.length, 1);

    // After it, one request tries again; the copy stays stale until a refresh works.
    advance(6 * 60 * 1000);
    const ctx3 = fakeCtx();
    assert.equal((await (await call('/api/health', fakeEnv(), ctx3)).json()).stale, true);
    await ctx3.settle();
    assert.equal(state.upstream.calls.length, 2);

    stubUpstream(() => feedResponse());
    advance(6 * 60 * 1000);
    const ctx4 = fakeCtx();
    await call('/api/health', fakeEnv(), ctx4);
    await ctx4.settle();
    const healed = await (await call('/api/health', fakeEnv())).json();
    assert.equal(healed.stale, false);
    assert.equal(healed.count, 29);
  });

  it('does not ask Apple on every request while it is down past 24 hours', async () => {
    await seed(ago(48 * 3600 * 1000));
    stubUpstream(() => new Response('nope', { status: 503 }));
    for (let i = 0; i < 4; i += 1) {
      const body = await (await call('/api/releases.json', fakeEnv())).json();
      assert.equal(body.stale, true);
      assert.equal(body.releases.length, 1);
    }
    assert.equal(state.upstream.calls.length, 1);
  });

  it('serves the snapshot with stale and snapshot true when Apple fails and nothing is cached', async () => {
    stubUpstream(() => {
      throw new TypeError('network down');
    });
    const res = await call('/api/releases.json', fakeEnv());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.stale, true);
    assert.equal(body.snapshot, true);
    assert.deepEqual(body.releases, SNAPSHOT.releases);
    // The snapshot is never cached as if it were live: only a marker without releases.
    const marker = state.cache.store.get(CACHE_URL);
    assert.equal(state.cache.store.size, 1);
    const stored = await marker.res.clone().json();
    assert.equal(stored.negative, true);
    assert.deepEqual(stored.releases, []);
    assert.ok(marker.maxAge <= 300, `the marker lives ${marker.maxAge} s`);
  });

  it('does not ask again within the back-off when nothing was cached', async () => {
    stubUpstream(() => new Response('nope', { status: 503 }));
    const first = await (await call('/api/releases.json', fakeEnv())).json();
    assert.equal(first.snapshot, true);
    assert.equal(state.upstream.calls.length, 1);
    for (const path of ['/api/releases.json', '/api/health', '/api/health']) {
      const body = await (await call(path, fakeEnv())).json();
      assert.equal(body.stale, true, path);
    }
    assert.equal(state.upstream.calls.length, 1, 'a cold cache backs off like a cached copy');
    // After RETRY_MS one request tries again, and a success replaces the marker.
    advance(6 * 60 * 1000);
    stubUpstream(() => feedResponse());
    const healed = await (await call('/api/releases.json', fakeEnv())).json();
    assert.equal(healed.stale, false);
    assert.equal(healed.releases.length, 29);
    assert.equal(state.upstream.calls.length, 1);
  });

  it('shares one live fetch between simultaneous cold requests', async () => {
    let answer;
    stubUpstream(() => new Promise((resolve) => (answer = resolve)));
    const pending = Promise.all([
      call('/api/releases.json', fakeEnv()),
      call('/api/releases.json', fakeEnv()),
      call('/api/health', fakeEnv()),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(state.upstream.calls.length, 1);
    answer(feedResponse());
    for (const res of await pending) assert.equal(res.status, 200);
    assert.equal(state.upstream.calls.length, 1);
  });

  it('does not extend the life of a copy by failing to refresh it', async () => {
    await seed(ago(3 * 24 * 3600 * 1000)); // fetched three days ago
    stubUpstream(() => new Response('nope', { status: 503 }));
    await call('/api/releases.json', fakeEnv());
    const kept = state.cache.store.get(CACHE_URL);
    assert.ok(kept.maxAge <= 4 * 24 * 3600 + 5, `re-put for ${kept.maxAge} s`);
    assert.ok(kept.maxAge >= 4 * 24 * 3600 - 5, `re-put for ${kept.maxAge} s`);
    // Past the 7 days the copy is gone and the snapshot answers.
    advance(5 * 24 * 3600 * 1000);
    const body = await (await call('/api/releases.json', fakeEnv())).json();
    assert.equal(body.snapshot, true);
  });

  it('never follows a redirect away from the allowlisted URL', async () => {
    stubUpstream(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
    const body = await (await call('/api/releases.json', fakeEnv())).json();
    assert.equal(state.upstream.calls[0].init.redirect, 'manual');
    assert.equal(body.snapshot, true, 'a 3xx is a failure, not a feed');
    assert.equal(state.upstream.calls.length, 1, 'and nothing else was fetched');
  });

  it('answers 503 only when nothing at all is available', async () => {
    stubUpstream(() => new Response('', { status: 500 }));
    const res = await call('/api/releases.json', fakeEnv(null));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('rejects a feed that is not a 200, or holds no releases', async () => {
    for (const handler of [() => new Response('x', { status: 301 }), () => feedResponse(rss())]) {
      stubUpstream(handler);
      advance(6 * 60 * 1000); // past the back-off the previous failure left
      const body = await (await call('/api/releases.json', fakeEnv())).json();
      assert.equal(body.snapshot, true);
    }
  });

  it('rejects an oversized body, declared or streamed', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024 + 1);
    stubUpstream(() => feedResponse(big));
    assert.equal((await (await call('/api/releases.json', fakeEnv())).json()).snapshot, true);

    advance(6 * 60 * 1000); // past the back-off the previous failure left
    stubUpstream(() => feedResponse(FEED, { headers: { 'content-length': String(big.length) } }));
    assert.equal((await (await call('/api/releases.json', fakeEnv())).json()).snapshot, true);

    // No content-length and an endless body: the count stops it.
    advance(6 * 60 * 1000);
    let sent = 0;
    stubUpstream(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              sent += 1;
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
          }),
        ),
    );
    assert.equal((await (await call('/api/releases.json', fakeEnv())).json()).snapshot, true);
    assert.ok(sent <= 4, `read ${sent} MB of an endless body`);
  });

  it('survives a timeout, and asks the platform for the 8 s one', async () => {
    const realTimeout = AbortSignal.timeout;
    let asked;
    AbortSignal.timeout = (ms) => {
      asked = ms;
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), 5);
      return controller.signal;
    };
    try {
      // Rejects only when the signal the Worker passed aborts, never on its own.
      stubUpstream(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
          }),
      );
      const res = await call('/api/releases.json', fakeEnv());
      assert.equal(asked, 8000);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).stale, true);
    } finally {
      AbortSignal.timeout = realTimeout;
    }
  });

  it('works when the edge cache is missing or throws', async () => {
    globalThis.caches = undefined;
    assert.equal((await call('/api/releases.json', fakeEnv())).status, 200);
    globalThis.caches = {
      default: {
        match: async () => {
          throw new Error('boom');
        },
        put: async () => {
          throw new Error('boom');
        },
      },
    };
    assert.equal((await call('/api/releases.json', fakeEnv())).status, 200);
  });

  it('answers HEAD with the headers and no body', async () => {
    const res = await call('/api/releases.json', fakeEnv(), fakeCtx(), { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
  });
});

describe('the Worker: /api/health and the rest', () => {
  it('reports health from the same data, with one entry per source', async () => {
    const res = await call('/api/health', fakeEnv());
    const fetchedAt = (await (await call('/api/releases.json', fakeEnv())).json()).fetchedAt;
    assert.deepEqual(await res.json(), {
      ok: true,
      degraded: false,
      fetchedAt,
      stale: false,
      count: 29,
      sources: [
        {
          id: APPLE_ID,
          vendor: 'apple',
          ok: true,
          stale: false,
          snapshot: false,
          fetchedAt,
          count: 29,
          lastError: null,
          failedAt: null,
        },
      ],
    });
  });

  it('logs nothing and is not degraded when every source is live', async () => {
    const errors = mock.method(console, 'error', () => {});
    try {
      const res = await call('/api/health', fakeEnv());
      const body = await res.json();
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(body.ok, true);
      assert.equal(body.degraded, false);
      assert.equal(errors.mock.callCount(), 0);
    } finally {
      errors.mock.restore();
    }
  });

  it('logs one structured error for a failed source and reports it degraded', async () => {
    const errors = mock.method(console, 'error', () => {});
    try {
      stubUpstream(() => new Response('secret body', { status: 503 }));
      const before = Date.now();
      const res = await call('/api/health', fakeEnv());
      const body = await res.json();
      assert.equal(errors.mock.callCount(), 1);
      const [entry] = errors.mock.calls[0].arguments;
      assert.deepEqual(JSON.parse(JSON.stringify(entry)), entry);
      assert.equal(entry.event, 'source_fetch_failed');
      assert.equal(entry.source, APPLE_ID);
      assert.equal(entry.host, new URL(FEED_URL).host);
      assert.match(entry.error, /503/);
      assert.equal(JSON.stringify(entry).includes('secret body'), false);

      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(body.ok, true, 'ok still means the Worker answered');
      assert.equal(body.degraded, true);
      const [apple] = body.sources;
      assert.equal(apple.stale, true);
      assert.equal(apple.snapshot, true);
      assert.match(apple.lastError, /503/);
      assert.ok(apple.failedAt >= before && apple.failedAt <= Date.now());

      // Inside the back-off the marker still tells the story, and nothing more is logged.
      const again = (await (await call('/api/health', fakeEnv())).json()).sources[0];
      assert.equal(again.lastError, apple.lastError);
      assert.equal(again.failedAt, apple.failedAt);
      assert.equal(errors.mock.callCount(), 1);
    } finally {
      errors.mock.restore();
    }
  });

  it('keeps the failure on a stale copy and cuts a URL in the message to its host', async () => {
    const errors = mock.method(console, 'error', () => {});
    try {
      await seed(ago(48 * 3600 * 1000));
      stubUpstream(() => {
        throw new TypeError(`connect failed for ${FEED_URL}?token=abc`);
      });
      const body = await (await call('/api/health', fakeEnv())).json();
      assert.equal(body.degraded, true);
      const [apple] = body.sources;
      assert.equal(apple.snapshot, false);
      assert.equal(apple.stale, true);
      assert.equal(apple.lastError.includes('token'), false);
      assert.ok(apple.lastError.includes(new URL(FEED_URL).host));
      assert.equal(errors.mock.callCount(), 1);
      assert.equal(JSON.stringify(errors.mock.calls[0].arguments[0]).includes('token'), false);
    } finally {
      errors.mock.restore();
    }
  });

  it('reports a stale snapshot as ok but stale', async () => {
    stubUpstream(() => new Response('', { status: 500 }));
    const body = await (await call('/api/health', fakeEnv())).json();
    assert.equal(body.ok, true);
    assert.equal(body.stale, true);
    assert.equal(body.count, 1);
  });

  it('answers 503 ok false when nothing is available', async () => {
    stubUpstream(() => new Response('', { status: 500 }));
    const res = await call('/api/health', fakeEnv(null));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).ok, false);
  });

  it('keeps the failure in a 503 health when there is no snapshot to carry it', async () => {
    const errors = mock.method(console, 'error', () => {});
    try {
      stubUpstream(() => new Response('', { status: 503 }));
      const before = Date.now();
      const res = await call('/api/health', fakeEnv(null));
      assert.equal(res.status, 503);
      const [first] = (await res.json()).sources;
      assert.equal(first.ok, false);
      assert.match(first.lastError, /503/);
      assert.equal(typeof first.failedAt, 'number');
      assert.ok(first.failedAt >= before && first.failedAt <= Date.now());

      // Inside the back-off the failure comes from the stored marker.
      const again = await call('/api/health', fakeEnv(null));
      assert.equal(again.status, 503);
      const [second] = (await again.json()).sources;
      assert.equal(second.lastError, first.lastError);
      assert.equal(second.failedAt, first.failedAt);
      assert.equal(errors.mock.callCount(), 1);
    } finally {
      errors.mock.restore();
    }
  });

  it('answers JSON 404 for any other /api path', async () => {
    for (const path of ['/api/', '/api/nope', '/api/releases']) {
      const res = await call(path, fakeEnv());
      assert.equal(res.status, 404, path);
      assert.match(res.headers.get('content-type'), /^application\/json/);
      assert.ok((await res.json()).error);
    }
  });

  it('answers 405 to anything but GET and HEAD', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await call('/api/releases.json', fakeEnv(), fakeCtx(), { method });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get('allow'), 'GET, HEAD');
    }
    assert.equal(state.upstream.calls.length, 0);
  });

  it('hands every other path to the static assets', async () => {
    const env = fakeEnv();
    const res = await call('/about/', env);
    assert.equal(await res.text(), 'asset');
    assert.deepEqual(env.calls, ['/about/']);
    const post = await call('/contact', env, fakeCtx(), { method: 'POST' });
    assert.equal(await post.text(), 'asset');
  });

  it('sets the full header set on every API response', async () => {
    const csp = /^ {2}Content-Security-Policy: (.+)$/m.exec(HEADERS_FILE)[1];
    const responses = [
      await call('/api/releases.json', fakeEnv()),
      await call('/api/health', fakeEnv()),
      await call('/api/nope', fakeEnv()),
      await call('/api/health', fakeEnv(), fakeCtx(), { method: 'POST' }),
    ];
    stubUpstream(() => new Response('', { status: 500 }));
    responses.push(await call('/api/releases.json', fakeEnv(null)));
    for (const res of responses) {
      assert.match(res.headers.get('content-type'), /^application\/json; charset=utf-8$/);
      assert.equal(res.headers.get('content-security-policy'), csp);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.equal(res.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
      assert.ok(res.headers.get('cache-control'));
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    }
    // Releases and an unknown path are cacheable for a minute; health is never cached.
    const [releases, health, nope] = responses;
    assert.equal(releases.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.equal(nope.headers.get('cache-control'), 'public, max-age=60');
  });
});

// A source with two URLs, to see how a source is fetched.
const DUO_ID = 'duo-feed';
const DUO_URLS = ['https://duo.example/a.txt', 'https://duo.example/b.txt'];
const duoRelease = (id, date) => ({
  id,
  vendor: 'duo',
  family: 'Pair',
  version: '1.0',
  major: 1,
  stage: 'release',
  beta: null,
  build: id,
  title: `Pair ${id}`,
  date,
  url: `https://duo.example/${id}`,
  source: DUO_ID,
});
const duo = {
  id: DUO_ID,
  vendor: 'duo',
  urls: DUO_URLS,
  parse: (text) => text.split('\n').filter(Boolean).map((line) => duoRelease(...line.split(' '))),
};
const duoWorker = createWorker([duo]);
const duoCall = (env = fakeEnv(null), ctx = fakeCtx()) =>
  duoWorker.fetch(new Request(`${ORIGIN}/api/releases.json`), env, ctx);
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('the Worker: fetching a source', () => {
  it('asks every URL of a source at once, under one deadline', async () => {
    const realTimeout = AbortSignal.timeout;
    let timeouts = 0;
    AbortSignal.timeout = (ms) => {
      timeouts += 1;
      return realTimeout.call(AbortSignal, ms);
    };
    try {
      const answers = {};
      stubUpstream((url) => new Promise((resolve) => (answers[url] = resolve)));
      const pending = duoCall();
      await tick();
      // Both are on the wire before either has answered.
      assert.deepEqual(state.upstream.calls.map((c) => c.url), DUO_URLS);
      assert.equal(timeouts, 1);
      const [first, second] = state.upstream.calls;
      assert.equal(first.init.signal, second.init.signal);
      answers[DUO_URLS[1]](new Response('b2 2026-02-02T00:00:00Z\n'));
      answers[DUO_URLS[0]](new Response('a1 2026-01-01T00:00:00Z\n'));
      const body = await (await pending).json();
      assert.deepEqual(body.releases.map((r) => r.id), ['b2', 'a1']);
      assert.equal(body.stale, false);
    } finally {
      AbortSignal.timeout = realTimeout;
    }
  });

  it('fails the source when one of its URLs fails', async () => {
    stubUpstream((url) =>
      url === DUO_URLS[0] ? new Response('a1 2026-01-01T00:00:00Z\n') : new Response('', { status: 503 }),
    );
    const res = await duoCall();
    assert.equal(res.status, 503); // no snapshot, no cache: nothing at all
    assert.equal(state.upstream.calls.length, 2);
  });

  it('replaces a shared fetch that has been pending past its deadline', async () => {
    stubUpstream(() => new Promise(() => {})); // a promise that never settles
    duoCall(); // left hanging on purpose
    await tick();
    assert.equal(state.upstream.calls.length, 2);

    advance(5000); // still inside the deadline: joins the first fetch
    duoCall();
    await tick();
    assert.equal(state.upstream.calls.length, 2);

    advance(6000); // past it: the lost fetch is replaced
    stubUpstream(() => new Response('a1 2026-01-01T00:00:00Z\n'));
    const res = await duoCall();
    assert.equal(res.status, 200);
    assert.equal(state.upstream.calls.length, 2); // two new URL fetches, on the new stub
    assert.deepEqual((await res.json()).releases.map((r) => r.id), ['a1']);
  });

  it('stops the other URLs of a source when one of them fails', async () => {
    let second;
    stubUpstream((url, init) =>
      url === DUO_URLS[0]
        ? new Response('', { status: 503 })
        : new Promise((_resolve, reject) => {
            second = init.signal;
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
          }),
    );
    const res = await duoCall();
    assert.equal(res.status, 503);
    assert.equal(second.aborted, true, 'the sibling fetch was aborted, not left running');
  });

  it('answers from the snapshot at the deadline even when a fetch ignores the abort', async () => {
    const realTimeout = AbortSignal.timeout;
    AbortSignal.timeout = () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), 5);
      return controller.signal;
    };
    try {
      stubUpstream(() => new Promise(() => {})); // never settles, whatever the signal says
      const res = await call('/api/releases.json', fakeEnv());
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.snapshot, true);
      assert.equal(body.stale, true);
    } finally {
      AbortSignal.timeout = realTimeout;
    }
  });

  it('leaves the cache alone when a replaced fetch succeeds late', async () => {
    const hung = [];
    stubUpstream((url) => new Promise((resolve) => hung.push({ url, resolve })));
    duoCall(); // the lost fetch
    await tick();
    assert.equal(hung.length, 2);

    advance(12000); // past INFLIGHT_MAX_MS: the next request replaces it
    stubUpstream((url) =>
      new Response(url === DUO_URLS[0] ? 'a1 2026-01-01T00:00:00Z\n' : 'b2 2026-02-02T00:00:00Z\n'),
    );
    await duoCall();
    const key = cacheUrl(DUO_ID);
    const written = state.cache.store.get(key);
    assert.ok(written, 'the replacement cached its result');

    // The lost fetch ends now, with older data, and must not overwrite the newer copy.
    for (const { resolve } of hung) resolve(new Response('z9 2025-01-01T00:00:00Z\n'));
    await tick();
    assert.equal(state.cache.store.get(key), written);
  });

  it('does not mark the source failed when a replaced fetch fails late', async () => {
    const hung = [];
    stubUpstream((url) => new Promise((resolve) => hung.push({ url, resolve })));
    const lostCtx = fakeCtx();
    const lost = duoCall(fakeEnv(null), lostCtx); // the caller of the lost fetch
    await tick();

    advance(12000);
    stubUpstream((url) =>
      new Response(url === DUO_URLS[0] ? 'a1 2026-01-01T00:00:00Z\n' : 'b2 2026-02-02T00:00:00Z\n'),
    );
    await duoCall();
    const key = cacheUrl(DUO_ID);
    const written = state.cache.store.get(key);

    for (const { resolve } of hung) resolve(new Response('', { status: 503 }));
    const res = await lost;
    await lostCtx.settle();
    assert.equal(res.status, 503, 'nothing cached, no snapshot, for this caller');
    assert.equal(state.cache.store.get(key), written, 'no failure marker over the newer copy');
  });

  it('registers the shared fetch with the waitUntil of the request that started it', async () => {
    let answer;
    stubUpstream(() => new Promise((resolve) => (answer = resolve)));
    const ctxs = [fakeCtx(), fakeCtx()];
    const pending = Promise.all(ctxs.map((ctx) => call('/api/releases.json', fakeEnv(), ctx)));
    await tick();
    assert.equal(state.upstream.calls.length, 1);
    assert.equal(ctxs[0].pending.length + ctxs[1].pending.length, 1, 'exactly one creator');
    answer(feedResponse());
    for (const res of await pending) assert.equal(res.status, 200);
    await Promise.all(ctxs.map((ctx) => ctx.settle())); // and it settles without throwing
  });

  it('does not leave an unhandled rejection when the registered fetch fails', async () => {
    stubUpstream(() => new Response('nope', { status: 503 }));
    const ctx = fakeCtx();
    const body = await (await call('/api/releases.json', fakeEnv(), ctx)).json();
    assert.equal(body.snapshot, true);
    assert.equal(ctx.pending.length, 1);
    await ctx.settle(); // the waitUntil copy resolves even though the fetch failed
  });
});

describe('the Worker: the bundled snapshot', () => {
  const reads = (env) => env.calls.filter((path) => path === '/data/releases.json').length;
  const refreshOnce = async (env) => {
    advance(11 * 60 * 1000); // past the fresh window, so a background refresh runs
    const ctx = fakeCtx();
    await call('/api/releases.json', env, ctx);
    await ctx.settle();
  };

  it('is read once per deploy version, not once per request', async () => {
    const env = fakeEnv(SNAPSHOT, 'v-memo-1');
    await call('/api/releases.json', env); // cold fetch
    await refreshOnce(env);
    await refreshOnce(env);
    assert.equal(state.upstream.calls.length, 3);
    assert.equal(reads(env), 1);
  });

  it('is read again after a new deploy, and serves the new data', async () => {
    const env = fakeEnv(SNAPSHOT, 'v-memo-2');
    await call('/api/releases.json', env);
    const fresh = {
      ...SNAPSHOT,
      releases: [
        {
          ...SNAPSHOT.releases[0],
          id: 'https://developer.apple.com/news/releases/?id=newdeploy',
          date: '2025-10-01T00:00:00Z',
        },
      ],
    };
    const next = fakeEnv(fresh, 'v-memo-3');
    await refreshOnce(next);
    assert.equal(reads(next), 1);
    const body = await (await call('/api/releases.json', next)).json();
    assert.ok(body.releases.some((r) => r.id.endsWith('id=newdeploy')));
  });

  it('is read on every use when the deploy has no readable version', async () => {
    const env = fakeEnv(); // no /version.txt
    await call('/api/releases.json', env);
    await refreshOnce(env);
    assert.equal(reads(env), 2);
  });

  it('does not share a snapshot read that another request left pending', async () => {
    const env = fakeEnv(SNAPSHOT, 'v-memo-5');
    const assets = env.ASSETS.fetch;
    let hung = false;
    env.ASSETS.fetch = (input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      if (path === '/data/releases.json' && !hung) {
        hung = true;
        return new Promise(() => {}); // the first read never finishes
      }
      return assets(input);
    };
    stubUpstream(() => new Response('nope', { status: 503 }));
    call('/api/releases.json', env); // left hanging on its snapshot read, on purpose
    await tick();
    assert.equal(hung, true);
    // Inside the back-off: this request reads the snapshot itself instead of waiting.
    const res = await call('/api/releases.json', env);
    assert.equal((await res.json()).snapshot, true);
  });

  it('does not remember a snapshot that could not be read', async () => {
    const broken = fakeEnv(null, 'v-memo-4');
    stubUpstream(() => new Response('nope', { status: 503 }));
    await call('/api/releases.json', broken);
    await tick();
    const env = fakeEnv(SNAPSHOT, 'v-memo-4'); // same version, now readable
    advance(6 * 60 * 1000); // past the back-off the failure left
    const body = await (await call('/api/releases.json', env)).json();
    assert.equal(body.snapshot, true);
    assert.equal(body.releases.length, 1);
  });
});

describe('the Worker: hosts that may fetch live', () => {
  const at = (host, path, env = fakeEnv(), ctx = fakeCtx()) =>
    worker.fetch(new Request(`https://${host}${path}`), env, ctx);

  // Every cache method records its use, so a test can say the cache was never touched.
  const spyOnCache = () => {
    const used = [];
    for (const name of ['match', 'put', 'delete']) {
      const original = state.cache[name].bind(state.cache);
      state.cache[name] = (...args) => {
        used.push(name);
        return original(...args);
      };
    }
    return used;
  };

  it('names exactly the production and stage hosts, as docs/architecture.md does', () => {
    assert.deepEqual([...LIVE_HOSTS].sort(), ['orbit.szolotov.com', 'stage.orbit.szolotov.com']);
    const docs = readFileSync(new URL('../docs/architecture.md', import.meta.url), 'utf8');
    for (const host of LIVE_HOSTS) assert.ok(docs.includes(`\`${host}\``), `${host} in the docs`);
  });

  for (const host of ['orbit.szolotov.com', 'stage.orbit.szolotov.com', 'ORBIT.szolotov.com']) {
    it(`fetches live and caches on ${host}`, async () => {
      const res = await at(host, '/api/releases.json');
      const body = await res.json();
      assert.equal(body.stale, false);
      assert.equal(body.snapshot, false);
      assert.equal(state.upstream.calls.length, 1);
      assert.equal(state.cache.store.size, 1);
    });
  }

  for (const host of [
    'orbit.acct.workers.dev',
    'pr-1.orbit.acct.workers.dev',
    'orbit.szolotov.com.',
    'evil.orbit.szolotov.com',
    'orbit.szolotov.com.evil.example',
    'szolotov.com',
    'localhost',
  ]) {
    it(`answers from the snapshot alone on ${host}`, async () => {
      const used = spyOnCache();
      const live = { ...SNAPSHOT.releases[0], id: 'https://developer.apple.com/news/releases/?id=live1' };
      await seed(ago(60 * 1000), {}, APPLE_ID, [live]); // production's copy: not to be served
      used.length = 0;
      const ctx = fakeCtx();
      const res = await at(host, '/api/releases.json', fakeEnv(), ctx);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.snapshot, true);
      assert.equal(body.stale, true);
      assert.deepEqual(
        body.releases.map((release) => release.id),
        SNAPSHOT.releases.map((release) => release.id),
      );
      assert.equal(state.upstream.calls.length, 0, 'no vendor is fetched');
      assert.deepEqual(used, [], 'the cache is neither read nor written');
      assert.equal(ctx.pending.length, 0, 'nothing is left running in the background');
    });
  }

  it('applies to the vendor filter and /api/health too', async () => {
    const host = 'orbit.acct.workers.dev';
    const used = spyOnCache();
    const one = await (await at(host, '/api/releases.json?vendor=apple')).json();
    assert.equal(one.snapshot, true);
    const unknown = await at(host, '/api/releases.json?vendor=nope');
    assert.equal(unknown.status, 400);
    const errors = mock.method(console, 'error', () => {});
    let healthRes;
    try {
      healthRes = await at(host, '/api/health');
      assert.equal(errors.mock.callCount(), 0, 'nothing is logged off the live hosts');
    } finally {
      errors.mock.restore();
    }
    const health = await healthRes.json();
    assert.equal(healthRes.headers.get('cache-control'), 'no-store');
    assert.equal(health.degraded, true);
    assert.equal(health.ok, true);
    assert.equal(health.stale, true);
    assert.equal(health.count, 1);
    assert.equal(health.sources[0].stale, true);
    assert.equal(health.sources[0].snapshot, true);
    assert.equal(health.sources[0].lastError, null);
    assert.equal(health.sources[0].failedAt, null);
    assert.equal(state.upstream.calls.length, 0);
    assert.deepEqual(used, []);
  });

  it('answers 503 off the live hosts when the snapshot cannot be read', async () => {
    const res = await at('orbit.acct.workers.dev', '/api/releases.json', fakeEnv(null));
    assert.equal(res.status, 503);
    assert.equal(state.upstream.calls.length, 0);
  });

  it('keeps refusing other methods off the live hosts', async () => {
    const res = await worker.fetch(
      new Request('https://orbit.acct.workers.dev/api/releases.json', { method: 'POST' }),
      fakeEnv(),
      fakeCtx(),
    );
    assert.equal(res.status, 405);
  });
});

describe('the Worker: the owner notes', () => {
  // An ASSETS binding that also serves /data/notes.json with `notes` (a status code when a number).
  const withNotes = (notes) => {
    const env = fakeEnv();
    const assets = env.ASSETS.fetch;
    env.ASSETS.fetch = async (input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      if (path !== '/data/notes.json') return assets(input);
      return typeof notes === 'number' ? new Response('gone', { status: notes }) : Response.json(notes);
    };
    return env;
  };
  const summaryOf = (body, id) => body.releases.find((release) => release.id === id)?.summary;
  const SNAPSHOT_ID = SNAPSHOT.releases[0].id;

  it('lays a note over the release it names', async () => {
    const env = withNotes({ schema: 1, notes: { [SNAPSHOT_ID]: ' The  first\nrelease. ' } });
    const body = await (await call('/api/releases.json', env)).json();
    assert.equal(summaryOf(body, SNAPSHOT_ID), 'The first release.');
    assert.equal(body.releases.filter((release) => 'summary' in release).length, 1);
  });

  it('serves the same releases without a summary when there is no notes file', async () => {
    for (const env of [fakeEnv(), withNotes(404), withNotes('not an object'), withNotes({ notes: [] })]) {
      const body = await (await call('/api/releases.json', env)).json();
      assert.equal(body.releases.length, 29);
      assert.ok(body.releases.every((release) => !('summary' in release)));
    }
  });

  it('does not store a note in the source cache', async () => {
    // A release the Apple feed itself produced, so it is in the cache entry being checked.
    await call('/api/releases.json', fakeEnv());
    const first = (await (await state.cache.match(CACHE_URL)).json()).releases[0].id;
    const env = withNotes({ notes: { [first]: 'A note.' } });
    const body = await (await call('/api/releases.json', env)).json();
    assert.equal(summaryOf(body, first), 'A note.');
    const cached = await (await state.cache.match(CACHE_URL)).json();
    assert.ok(cached.releases.some((release) => release.id === first));
    assert.ok(cached.releases.every((release) => !('summary' in release)));
  });
});
