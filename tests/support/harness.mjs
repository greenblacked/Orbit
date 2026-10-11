// Shared fakes for the Worker tests: an edge cache that expires entries, an ASSETS binding
// that serves a snapshot, a clock that can be moved, and a stub for the upstream fetch.
// node:test and node:assert only; nothing to install.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FEED_URL } from '../../deploy/sources/apple.js';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

export const FEED = readFileSync(here('../fixtures/releases.rss'), 'utf8');
export const HEADERS_FILE = readFileSync(here('../../src/_headers'), 'utf8');
export const ORIGIN = 'https://orbit.example';
export const APPLE_ID = 'apple-developer-releases';
export { FEED_URL };

export const item = (title, pubDate, id = title) =>
  `<item><title>${title}</title><link>https://developer.apple.com/news/releases/?id=${id}</link>` +
  `<guid>https://developer.apple.com/news/releases/?id=${id}</guid><pubDate>${pubDate}</pubDate></item>`;
export const rss = (...items) =>
  `<?xml version="1.0"?><rss><channel>${items.join('')}</channel></rss>`;

export const SNAPSHOT = {
  source: APPLE_ID,
  fetchedAt: '2026-01-01T00:00:00Z',
  stale: false,
  snapshot: true,
  releases: [
    {
      id: 'https://developer.apple.com/news/releases/?id=old1',
      vendor: 'apple',
      family: 'iOS',
      version: '26.0',
      major: 26,
      stage: 'release',
      beta: null,
      build: '23A1',
      title: 'iOS 26.0 (23A1)',
      date: '2025-09-15T17:00:00Z',
      url: 'https://developer.apple.com/news/releases/?id=old1',
      source: APPLE_ID,
    },
  ],
};

// Like the edge cache: an entry is gone once its cache-control max-age has passed.
export function fakeCache() {
  const store = new Map();
  const key = (k) => (typeof k === 'string' ? k : k.url);
  return {
    store,
    async match(k) {
      const hit = store.get(key(k));
      if (!hit) return undefined;
      if (Date.now() - hit.storedAt > hit.maxAge * 1000) {
        store.delete(key(k));
        return undefined;
      }
      return hit.res.clone();
    },
    async put(k, res) {
      const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '');
      store.set(key(k), {
        res,
        storedAt: Date.now(),
        maxAge: m ? Number(m[1]) : Number.POSITIVE_INFINITY,
      });
    },
  };
}

// An ASSETS binding that serves `snapshot` at /data/releases.json and "asset" elsewhere.
export function fakeEnv(snapshot = SNAPSHOT) {
  const calls = [];
  return {
    calls,
    ASSETS: {
      async fetch(input) {
        const request = input instanceof Request ? input : new Request(input);
        calls.push(new URL(request.url).pathname);
        if (new URL(request.url).pathname === '/data/releases.json' && snapshot) {
          return Response.json(snapshot);
        }
        return new Response('asset', { status: snapshot ? 200 : 404 });
      },
    },
  };
}

export function fakeCtx() {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p), settle: () => Promise.all(pending) };
}

export const feedResponse = (text = FEED, init = {}) => new Response(text, { status: 200, ...init });

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;
const realNow = Date.now;
let skew = 0;

/** The state a test reads: the fake edge cache and the upstream calls. */
export const state = { cache: null, upstream: null };

export const advance = (ms) => {
  skew += ms;
};

export function stubUpstream(handler) {
  state.upstream = { calls: [] };
  globalThis.fetch = async (url, init) => {
    state.upstream.calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
}

/** Install the fakes before each test and restore the globals after it. */
export function useHarness() {
  beforeEach(() => {
    skew = 0;
    Date.now = () => realNow() + skew;
    state.cache = fakeCache();
    globalThis.caches = { default: state.cache };
    stubUpstream(() => feedResponse());
  });
  afterEach(() => {
    Date.now = realNow;
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  });
}

export const cacheUrl = (id) => `https://orbit.internal/api/sources/${encodeURIComponent(id)}.json`;
export const ago = (ms) => new Date(Date.now() - ms).toISOString();

/** Put a copy of one source's payload in the fake edge cache, as the Worker would. */
export function seed(fetchedAt, extra = {}, id = APPLE_ID, releases = SNAPSHOT.releases) {
  return state.cache.put(
    cacheUrl(id),
    new Response(
      JSON.stringify({ source: id, stale: false, releases, fetchedAt, snapshot: false, ...extra }),
      { headers: { 'cache-control': 'public, max-age=604800' } },
    ),
  );
}
