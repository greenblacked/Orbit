// Tests for the releases API Worker over the Apple source (the other adapters have their own tests).
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import apple from '../deploy/sources/apple.js';
import { createWorker } from '../deploy/worker.js';
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
    assert.equal(ctx.pending.length, 1);
    assert.equal(state.upstream.calls.length, 1);

    answer(feedResponse());
    await ctx.settle();
    const next = await call('/api/releases.json', fakeEnv());
    assert.equal((await next.json()).releases.length, 29);
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
      fetchedAt,
      stale: false,
      count: 29,
      sources: [{ id: APPLE_ID, vendor: 'apple', ok: true, stale: false, fetchedAt, count: 29 }],
    });
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
    for (const res of responses.slice(0, 3)) {
      assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
    }
  });
});
