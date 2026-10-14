// The releases API. Only /api/* reaches this Worker (wrangler.json: run_worker_first);
// everything else is the static site, served by the ASSETS binding.
//
//   GET /api/releases.json            the releases of every vendor
//   GET /api/releases.json?vendor=X   only the releases of vendor X (400 for an unknown one)
//   GET /api/security.json            the bundled security notes (/data/security.json), unchanged in content
//   GET /api/health                   {ok, fetchedAt, stale, count, sources}
//
// The Worker iterates the registry of source adapters (sources/index.js). Each source has
// its own edge-cache entry, its own refresh and its own fallback, so a source that fails
// never blanks the others: a response is built from whichever sources have data, and says
// `stale` when any of them is out of date or has nothing at all.
//
// A source's feed carries only its latest items, so a live result is merged with the
// bundled snapshot (/data/releases.json) and with the copy already cached, and history
// survives beyond both the feed and the snapshot. `stale` means "the source could not be
// reached, this is the last good copy"; `snapshot` means the copy is the one built into
// the deploy. A copy past its fresh window is still served at once while a
// refresh runs in the background. A refresh that fails leaves a `failedAt` mark on the
// cached copy: from then on the copy is served with stale true, and the source is not asked
// again until RETRY_MS has passed. With nothing cached, a failed fetch leaves a short
// negative marker (no releases, just failedAt) that holds the same back-off, so an outage
// does not make every request wait for the timeout. The cache keeps a live copy for
// STORE_MS, counted from when it was fetched and not extended by failed refreshes, far
// longer than MAX_AGE_MS, so the last good live copy outlives an outage instead of giving
// way to the older snapshot built into the deploy.

import { mergeReleases } from './releases.js';
import { SOURCES, isSource, vendorsOf } from './sources/index.js';

const USER_AGENT = 'orbit (+https://orbit.szolotov.com)';
const CACHE_PREFIX = 'https://orbit.internal/api/sources/';
const FRESH_MS = 10 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const STORE_MS = 7 * 24 * 60 * 60 * 1000;
// One deadline for a whole source: its URLs are fetched together and share one signal, so a
// source with several URLs waits as long as one, not the sum.
const FETCH_TIMEOUT_MS = 8000;
// A shared fetch older than this is treated as lost and replaced (see fetchAndStore).
const INFLIGHT_MAX_MS = FETCH_TIMEOUT_MS + 2000;
// What a source is asked for unless its adapter says otherwise: feeds first, then JSON and the
// plain text of MikroTik's NEWEST files. An HTML source sets its own `accept` (see android.js).
export const DEFAULT_ACCEPT =
  'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, application/json;q=0.7, text/plain;q=0.6, */*;q=0.1';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

// _headers does not apply to a Worker's own responses, so they carry the same set here.
// tests/worker.test.mjs keeps the policy identical to src/_headers.
const API_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=60',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

function json(body, status = 200, extra = {}, head = false) {
  return new Response(head ? null : JSON.stringify(body), {
    status,
    headers: { ...API_HEADERS, ...extra },
  });
}

const now = () => new Date(Date.now()).toISOString();
const cacheKey = (source) => `${CACHE_PREFIX}${encodeURIComponent(source.id)}.json`;

function usable(payload) {
  return payload && typeof payload === 'object' && Array.isArray(payload.releases);
}

async function readCache(source) {
  try {
    const hit = await globalThis.caches?.default?.match(cacheKey(source));
    if (!hit) return null;
    const payload = await hit.json();
    if (!usable(payload) || !Number.isFinite(Date.parse(payload.fetchedAt))) return null;
    // Whatever the cache still holds, a copy older than STORE_MS is not served.
    return Date.now() - Date.parse(payload.fetchedAt) > STORE_MS ? null : payload;
  } catch {
    return null;
  }
}

async function writeCache(source, payload, ttlMs = STORE_MS) {
  try {
    await globalThis.caches?.default?.put(
      cacheKey(source),
      new Response(JSON.stringify(payload), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': `public, max-age=${Math.max(1, Math.floor(ttlMs / 1000))}`,
        },
      }),
    );
  } catch {
    // A cache that cannot be written only costs the next request a live fetch.
  }
}

async function dropCache(source) {
  try {
    await globalThis.caches?.default?.delete(cacheKey(source));
  } catch {
    // Nothing to do: readCache ignores a copy past STORE_MS anyway.
  }
}

// The bundled snapshot is parsed once per isolate. It is keyed by the deploy's version
// (/version.txt), so a new deploy is read afresh; without a readable version nothing is kept.
let snapshotMemo = null;

async function deployVersion(env, request) {
  try {
    const res = await env.ASSETS.fetch(new URL('/version.txt', request.url));
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text && text.length <= 80 ? text : null;
  } catch {
    return null;
  }
}

async function parseSnapshot(env, request) {
  try {
    const res = await env.ASSETS.fetch(new URL('/data/releases.json', request.url));
    if (!res.ok) return null;
    const payload = await res.json();
    return usable(payload) ? payload : null;
  } catch {
    return null;
  }
}

async function bundledSnapshot(env, request) {
  const version = await deployVersion(env, request);
  if (version === null) {
    const payload = await parseSnapshot(env, request);
    return payload && { memo: null, payload };
  }
  if (snapshotMemo?.version === version) {
    return { memo: snapshotMemo, payload: snapshotMemo.payload };
  }
  // Only a payload that was read is remembered, never a pending promise: a request cut off
  // mid-read must not leave the others waiting on it. A snapshot that could not be read is
  // not remembered either, so the next request tries again.
  const payload = await parseSnapshot(env, request);
  if (!payload) return null;
  snapshotMemo = { version, payload, bySource: new Map() };
  return { memo: snapshotMemo, payload };
}

// The bundled snapshot, narrowed to what one source produced; null when it holds none.
async function readSnapshot(source, env, request) {
  const found = await bundledSnapshot(env, request);
  if (!found) return null;
  const { memo, payload } = found;
  let narrowed = memo ? memo.bySource.get(source.id) : undefined;
  if (narrowed === undefined) {
    const releases = payload.releases.filter((release) => release && release.source === source.id);
    narrowed = releases.length > 0 ? { ...payload, source: source.id, releases } : null;
    if (memo) memo.bySource.set(source.id, narrowed);
  }
  // A copy, so a caller can never change what the next request sees.
  return narrowed && { ...narrowed, releases: [...narrowed.releases] };
}

// The bundled security notes, or null when the asset is missing or is not a JSON object. They
// are parsed and served unchanged in content: the Worker fetches nothing for them.
async function readSecurity(env, request) {
  try {
    const res = await env.ASSETS.fetch(new URL('/data/security.json', request.url));
    if (!res.ok) return null;
    const payload = await res.json();
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

// The body as text, refusing to read past MAX_BODY_BYTES whatever the headers claim.
async function readCapped(res) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await res.body?.cancel();
    throw new Error('feed too large');
  }
  if (!res.body) throw new Error('feed has no body');
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error('feed too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(bytes);
}

// Fetch one URL of a source and parse it.
async function fetchOne(source, url, signal) {
  const res = await fetch(url, {
    // The allowlist covers the URL itself: a redirect would leave it, so none is followed.
    redirect: 'manual',
    signal,
    headers: {
      'user-agent': USER_AGENT,
      accept: source.accept || DEFAULT_ACCEPT,
    },
  });
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new Error(`${source.id} answered ${res.status}`);
  }
  return source.parse(await readCapped(res), url);
}

// Fetch every URL on the source's allowlist at once, under one deadline, and parse them.
// One URL failing fails the source and aborts the others. The work is raced against the
// signal itself, so the deadline holds even for a fetch or a body read that ignores the abort.
async function fetchLive(source, env, request, cached) {
  const stop = new AbortController();
  const signal = AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), stop.signal]);
  const deadline = new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  let parts;
  try {
    parts = await Promise.race([
      Promise.all(source.urls.map((url) => fetchOne(source, url, signal))),
      deadline,
    ]);
  } catch (error) {
    stop.abort();
    throw error;
  }
  const found = parts.flat();
  // Whatever an adapter says, a release belongs to the source and vendor that produced it.
  const live = found.map((release) => ({ ...release, vendor: source.vendor, source: source.id }));
  if (live.length === 0) throw new Error(`${source.id} held no releases`);
  const snapshot = await readSnapshot(source, env, request);
  return {
    source: source.id,
    fetchedAt: now(),
    stale: false,
    snapshot: false,
    // Snapshot, then the copy already cached, then the live feed: a release that has left a
    // short feed since the last fetch stays in the history.
    releases: mergeReleases(
      mergeReleases(snapshot ? snapshot.releases : [], cached ? cached.releases : []),
      live,
    ),
  };
}

// A cached copy as the API serves it: without the retry mark, with `stale` set.
function serve(cached, stale) {
  const { failedAt: _failedAt, ...payload } = cached;
  return { ...payload, stale };
}

// Remember that a source could not be reached, so later requests do not ask again at once.
// The copy keeps the lifetime it had: STORE_MS counts from when it was fetched, so a long
// outage cannot keep re-extending it.
async function markFailed(source, cached) {
  const left = STORE_MS - (Date.now() - Date.parse(cached.fetchedAt));
  if (left <= 0) {
    await dropCache(source);
    return;
  }
  await writeCache(source, { ...cached, failedAt: now() }, left);
}

// With nothing cached, remember the failure alone: no releases, just when it happened.
async function markUnavailable(source) {
  const stamp = now();
  await writeCache(
    source,
    { source: source.id, fetchedAt: stamp, failedAt: stamp, negative: true, releases: [] },
    RETRY_MS,
  );
}

const inflight = new Map();

// What a fetch that was replaced while it ran rejects with: it says nothing about the source,
// so no caller marks the source failed because of it.
class Replaced extends Error {}

// One live fetch per source at a time, whoever asks: a background refresh and requests on a
// cold cache share it. A success is cached; a failure rejects for each caller to handle.
// `cached` is the copy the caller holds, if any: its releases are kept in the merge.
// A promise shared across requests can be left pending by the platform, so an entry older than
// INFLIGHT_MAX_MS is replaced, and the fetch is always registered with the waitUntil of the
// request that started it, so it is not cut off when that request answers. A replaced fetch
// that ends later writes nothing to the cache and marks nothing: its replacement owns both.
function fetchAndStore(source, env, request, ctx, cached) {
  const current = inflight.get(source.id);
  if (current && Date.now() - current.startedAt <= INFLIGHT_MAX_MS) return current.promise;
  if (current) current.replaced = true;
  const entry = { startedAt: Date.now(), promise: null, replaced: false };
  entry.promise = (async () => {
    try {
      let live;
      try {
        live = await fetchLive(source, env, request, cached);
      } catch (error) {
        throw entry.replaced ? new Replaced('replaced') : error;
      }
      if (!entry.replaced) await writeCache(source, live);
      return live;
    } finally {
      // Only its own entry: a lost fetch that finally ends must not remove its replacement.
      if (inflight.get(source.id) === entry) inflight.delete(source.id);
    }
  })();
  inflight.set(source.id, entry);
  // The failure is for the callers; this copy only keeps the fetch alive.
  ctx.waitUntil(entry.promise.catch(() => undefined));
  return entry.promise;
}

// A background refresh; a failure leaves the retry mark on the copy it was refreshing.
function refresh(source, env, request, ctx, cached) {
  return fetchAndStore(source, env, request, ctx, cached).then(
    () => undefined,
    (error) => (error instanceof Replaced ? undefined : markFailed(source, cached)),
  );
}

// The snapshot built into the deploy, as the answer when a source cannot be reached.
async function fallback(source, request, env) {
  const snapshot = await readSnapshot(source, env, request);
  return snapshot ? { ...snapshot, stale: true, snapshot: true } : null;
}

// One source's payload to serve, or null when nothing at all is available for it.
async function load(source, request, env, ctx) {
  let cached = await readCache(source);
  if (cached?.negative) {
    // Nothing was cached and the last attempt failed: inside the back-off, do not ask again.
    if (Date.now() - Date.parse(cached.failedAt) < RETRY_MS) return fallback(source, request, env);
    cached = null;
  }
  if (cached) {
    const age = Date.now() - Date.parse(cached.fetchedAt);
    const failedAt = Date.parse(cached.failedAt);
    const failed = Number.isFinite(failedAt);
    if (failed && Date.now() - failedAt < RETRY_MS) return serve(cached, true);
    if (age <= FRESH_MS && !failed) return serve(cached, Boolean(cached.stale));
    if (age <= MAX_AGE_MS) {
      ctx.waitUntil(refresh(source, env, request, ctx, cached));
      return serve(cached, failed);
    }
  }
  try {
    return await fetchAndStore(source, env, request, ctx, cached);
  } catch (error) {
    const replaced = error instanceof Replaced;
    if (cached) {
      if (!replaced) await markFailed(source, cached);
      return serve(cached, true);
    }
    if (!replaced) await markUnavailable(source);
    return fallback(source, request, env);
  }
}

// load() never rejects for a source's own failure; this keeps even a bug in one adapter
// from taking the others down with it.
async function loadAll(sources, request, env, ctx) {
  return Promise.all(
    sources.map(async (source) => {
      try {
        return { source, payload: await load(source, request, env, ctx) };
      } catch {
        return { source, payload: null };
      }
    }),
  );
}

// One payload from the sources that have data. Anything missing makes it stale.
function combine(results) {
  const parts = results.map((result) => result.payload).filter(Boolean);
  if (parts.length === 0) return null;
  // The oldest copy sets the age of the whole answer (the original string, not a rewrite).
  const oldest = parts.reduce((a, b) => (Date.parse(b.fetchedAt) < Date.parse(a.fetchedAt) ? b : a));
  return {
    source: parts.map((part) => part.source).join(','),
    fetchedAt: oldest.fetchedAt,
    stale: parts.length < results.length || parts.some((part) => Boolean(part.stale)),
    snapshot: parts.some((part) => Boolean(part.snapshot)),
    releases: mergeReleases([], parts.flatMap((part) => part.releases)),
  };
}

function summary(results) {
  return results.map(({ source, payload }) => ({
    id: source.id,
    vendor: source.vendor,
    ok: Boolean(payload),
    stale: payload ? Boolean(payload.stale) : true,
    fetchedAt: payload ? payload.fetchedAt : null,
    count: payload ? payload.releases.length : 0,
  }));
}

async function api(request, env, ctx, sources) {
  const url = new URL(request.url);
  const head = request.method === 'HEAD';
  if (request.method !== 'GET' && !head) {
    return json({ error: 'method not allowed' }, 405, { allow: 'GET, HEAD' });
  }
  if (url.pathname === '/api/releases.json') {
    let chosen = sources;
    if (url.searchParams.has('vendor')) {
      const vendor = url.searchParams.get('vendor');
      chosen = sources.filter((source) => source.vendor === vendor);
      if (chosen.length === 0) {
        return json(
          { error: 'unknown vendor', vendors: vendorsOf(sources) },
          400,
          { 'cache-control': 'no-store' },
          head,
        );
      }
    }
    const payload = combine(await loadAll(chosen, request, env, ctx));
    return payload
      ? json(payload, 200, {}, head)
      : json({ error: 'no releases available' }, 503, { 'cache-control': 'no-store' }, head);
  }
  if (url.pathname === '/api/security.json') {
    const payload = await readSecurity(env, request);
    return payload
      ? json(payload, 200, {}, head)
      : json({ error: 'no security notes available' }, 503, { 'cache-control': 'no-store' }, head);
  }
  if (url.pathname === '/api/health') {
    const results = await loadAll(sources, request, env, ctx);
    const payload = combine(results);
    return payload
      ? json(
          {
            ok: true,
            fetchedAt: payload.fetchedAt,
            stale: payload.stale,
            count: payload.releases.length,
            sources: summary(results),
          },
          200,
          {},
          head,
        )
      : json(
          { ok: false, fetchedAt: null, stale: true, count: 0, sources: summary(results) },
          503,
          { 'cache-control': 'no-store' },
          head,
        );
  }
  return json({ error: 'not found' }, 404, {}, head);
}

/** A Worker over a list of source adapters; the tests pass their own list. */
export function createWorker(sources = SOURCES) {
  const valid = sources.filter(isSource);
  return {
    async fetch(request, env, ctx) {
      if (new URL(request.url).pathname.startsWith('/api/')) {
        return api(request, env, ctx, valid);
      }
      return env.ASSETS.fetch(request);
    },
  };
}

export default createWorker();
