#!/usr/bin/env node
// Refresh src/data/security.json from every adapter in deploy/security/index.js.
//
//   node deploy/snapshot_security.mjs
//
// The file is the security-notes payload (schema 1, ADR 0008). It holds CVE ids, page titles,
// dates and URLs for the releases already in src/data/releases.json, never a vendor's impact or
// description text. Run snapshot_releases.mjs first so the releases are current. Each vendor is
// read on its own: one whose index cannot be read keeps what the file already has for it and is
// marked `failed`, the others still update, and the script then exits non-zero. Pages are asked
// for one per second, each URL once per run, at most MAX_PAGES a vendor (Android reads its own
// months, at most 200, from the patch levels of the AOSP build-numbers page). No dependencies:
// node 22.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildPayload, MAX_PAGES, neededPages, pagesFor } from './security/build.js';
import { SECURITY_SOURCES } from './security/index.js';
import { payloadProblems } from './security/validate.js';

export { buildPayload, neededPages, pagesFor };

const USER_AGENT = 'orbit (+https://orbit.szolotov.com)';
const MAX_BYTES = 2 * 1024 * 1024;
const PAUSE_MS = 1000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let lastRequest = 0;

const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * One page as text; throws unless it answers 200 HTML within the size cap. A redirect is followed
 * by hand, at most MAX_REDIRECTS times, and only to an https URL on `hosts` (the adapter's own
 * allowlist) with no userinfo and no port; anything else fails the page. Every request asks for
 * English with Accept-Language. `options.lang` ({ param, value }, an adapter's `lang`) is for a
 * host that picks the language from a query parameter: each request carries param=value, and a
 * redirect to the same parameter with another value (any one of several) is refused (an English
 * variant such as en-US is followed as sent), so a localized page is never
 * parsed. The caller keeps keying the page by the URL it passed in. `options` is also for tests:
 * `fetchImpl` replaces fetch, `pauseMs` the pause between requests, `log` the progress line.
 */
export async function fetchPage(url, hosts, options = {}) {
  const { fetchImpl = fetch, pauseMs = PAUSE_MS, log = console.log, lang = null } = options;
  let current = url;
  // The URL actually requested: `current` with the language parameter set, unless a redirect
  // already carried an accepted English value, which is kept as it is.
  let request = withLang(url, lang);
  const seen = new Set();
  let res;
  for (let hops = 0; ; hops += 1) {
    const wait = lastRequest + pauseMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    seen.add(request);
    res = await fetchImpl(request, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html, application/xhtml+xml;q=0.9',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (!REDIRECTS.has(res.status)) break;
    await res.body?.cancel();
    const location = res.headers.get('location');
    if (!location) throw new Error(`${url} answered ${res.status} without a Location`);
    if (hops >= MAX_REDIRECTS) throw new Error(`${url} redirected more than ${MAX_REDIRECTS} times`);
    let next;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error(`${url} answered ${res.status} with an unreadable Location`);
    }
    if (!allowed(next.href, hosts)) {
      throw new Error(
        `${url} answered ${res.status} to ${next.protocol}//${next.host}, which is not allowed (https only, no userinfo or port, on ${hosts.join(', ')})`,
      );
    }
    if (lang) {
      for (const value of next.searchParams.getAll(lang.param)) {
        const asked = value.toLowerCase();
        if (asked !== lang.value && !asked.startsWith(`${lang.value}-`)) {
          throw new Error(
            `${url} answered ${res.status} to ${next.href}: redirected to a non-English variant (${lang.param}=${value}, asked for ${lang.value})`,
          );
        }
      }
    }
    // An accepted English value on the target is followed as it is; withLang only fills a missing one.
    const nextRequest = lang && next.searchParams.has(lang.param) ? next.href : withLang(next.href, lang);
    if (lang && (nextRequest === request || seen.has(nextRequest))) {
      throw new Error(`${url} redirects ${lang.param}=${lang.value} back to itself`);
    }
    log(`followed redirect ${current} -> ${next.href}`);
    current = next.href;
    request = nextRequest;
  }
  const where = current === url ? url : `${url} (via ${current})`;
  if (res.status !== 200) throw new Error(`${where} answered ${res.status}`);
  if (!/^text\/html\b/i.test(res.headers.get('content-type') ?? '')) {
    throw new Error(`${where} is not HTML`);
  }
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_BYTES) throw new Error(`${where} is over ${MAX_BYTES} bytes`);
  // Read the body in chunks and stop at the cap, so a page without a length is not buffered whole.
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) {
      await res.body.cancel();
      throw new Error(`${where} is over ${MAX_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

/** `url` with the adapter's language parameter set, other query parameters kept. */
function withLang(url, lang) {
  if (!lang) return url;
  const parsed = new URL(url);
  parsed.searchParams.set(lang.param, lang.value);
  return parsed.href;
}

/**
 * True when `url` is https, has no userinfo and no port, and its host is exactly one of `hosts`:
 * a page, an index or a redirect target is never read from anywhere else.
 */
export function allowed(url, hosts) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      hosts.includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function readJson(path, required) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && !required) return null;
    console.error(`cannot read ${path}: ${error.message}`);
    process.exit(1);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    console.error(`${path} is not valid JSON (${error.message}); it is left untouched`);
    process.exit(1);
  }
}

/**
 * Fetch each canonical URL of `adapter` into `pages`, keyed by that same URL: the adapter's `lang`
 * only changes the request (inside fetchPage), never the key, so note ids stay stable.
 */
export async function readPages(adapter, urls, cache, pages, options = {}) {
  for (const url of urls) {
    try {
      if (!allowed(url, adapter.hosts)) throw new Error(`${url} is not on ${adapter.hosts.join(', ')}`);
      if (!cache.has(url)) cache.set(url, await fetchPage(url, adapter.hosts, { ...options, lang: adapter.lang }));
      pages.set(url, cache.get(url));
    } catch (error) {
      console.error(`failed: ${adapter.id}: ${error.message}`);
    }
  }
}

/**
 * Read one source: its index, then the pages it needs. The index URL is held to the adapter's own
 * hosts (https only, no userinfo or port) before the first request, like every note URL. A source
 * that fails here, on any request or while choosing its pages comes back with `rows: null` and
 * whatever pages were read, and buildPayload records it as failed. `options` is as for fetchPage.
 */
export async function readSource(adapter, releases, cache, options = {}) {
  let rows = null;
  const pages = new Map();
  try {
    if (!allowed(adapter.index, adapter.hosts)) {
      throw new Error(`${adapter.index} is not on ${adapter.hosts.join(', ')}`);
    }
    const index = await fetchPage(adapter.index, adapter.hosts, { ...options, lang: adapter.lang });
    rows = adapter.parseIndex(index);
    await readPages(adapter, pagesFor(adapter, releases, rows, MAX_PAGES), cache, pages, options);
  } catch (error) {
    rows = null; // a failure after the index was parsed still fails this source alone
    console.error(`failed: ${adapter.id}: ${error.message}`);
  }
  return { adapter, rows, pages };
}

/**
 * Write `payload` to `target` unless it breaks the schema-1 shape (see security/validate.js); then
 * nothing is written and the error lists every problem.
 */
export function writePayload(target, payload) {
  const problems = payloadProblems(payload);
  if (problems.length > 0) {
    const list = problems.join('\n  ');
    throw new Error(`refusing to write ${target}; the payload is invalid:\n  ${list}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const target = resolve(root, 'src', 'data', 'security.json');
  const releases = readJson(resolve(root, 'src', 'data', 'releases.json'), true).releases;
  if (!Array.isArray(releases)) {
    console.error('src/data/releases.json has no releases list');
    process.exit(1);
  }
  const previous = readJson(target, false);

  const cache = new Map();
  const sources = [];
  for (const adapter of SECURITY_SOURCES) sources.push(await readSource(adapter, releases, cache));

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const { payload, failures } = buildPayload({ previous, releases, sources, now });
  try {
    writePayload(target, payload);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const counts = {};
  for (const value of Object.values(payload.releases)) {
    counts[value.status] = (counts[value.status] ?? 0) + 1;
  }
  console.log(`${Object.keys(payload.notes).length} notes`, JSON.stringify(counts));
  for (const failure of failures) console.error(`failed: ${failure}`);
  if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
