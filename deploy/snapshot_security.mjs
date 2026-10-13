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
 * redirect to the same parameter with another value is refused, so a localized page is never
 * parsed. The caller keeps keying the page by the URL it passed in. `options` is also for tests:
 * `fetchImpl` replaces fetch, `pauseMs` the pause between requests, `log` the progress line.
 */
export async function fetchPage(url, hosts, options = {}) {
  const { fetchImpl = fetch, pauseMs = PAUSE_MS, log = console.log, lang = null } = options;
  let current = url;
  let res;
  for (let hops = 0; ; hops += 1) {
    const wait = lastRequest + pauseMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    res = await fetchImpl(withLang(current, lang), {
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
    if (!onHosts(next.href, hosts) || next.username || next.password || next.port) {
      throw new Error(
        `${url} answered ${res.status} to ${next.protocol}//${next.host}, which is not allowed (https only, no userinfo or port, on ${hosts.join(', ')})`,
      );
    }
    if (lang && next.searchParams.has(lang.param)) {
      const asked = next.searchParams.get(lang.param).toLowerCase();
      if (asked !== lang.value && !asked.startsWith(`${lang.value}-`)) {
        throw new Error(
          `${url} answered ${res.status} to ${next.href}: redirected to a non-English variant (${lang.param}=${next.searchParams.get(lang.param)}, asked for ${lang.value})`,
        );
      }
    }
    if (lang && withLang(next.href, lang) === withLang(current, lang)) {
      throw new Error(`${url} redirects ${lang.param}=${lang.value} back to itself`);
    }
    log(`followed redirect ${current} -> ${next.href}`);
    current = next.href;
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

/** True when `url` is https on one of `hosts`: a page is never read from anywhere else. */
function onHosts(url, hosts) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && hosts.includes(parsed.hostname);
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
      if (!onHosts(url, adapter.hosts)) throw new Error(`${url} is not on ${adapter.hosts.join(', ')}`);
      if (!cache.has(url)) cache.set(url, await fetchPage(url, adapter.hosts, { ...options, lang: adapter.lang }));
      pages.set(url, cache.get(url));
    } catch (error) {
      console.error(`failed: ${adapter.id}: ${error.message}`);
    }
  }
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
  for (const adapter of SECURITY_SOURCES) {
    let rows = null;
    const pages = new Map();
    try {
      rows = adapter.parseIndex(await fetchPage(adapter.index, adapter.hosts, { lang: adapter.lang }));
      await readPages(adapter, pagesFor(adapter, releases, rows, MAX_PAGES), cache, pages);
    } catch (error) {
      console.error(`failed: ${adapter.id}: ${error.message}`);
    }
    sources.push({ adapter, rows, pages });
  }

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const { payload, failures } = buildPayload({ previous, releases, sources, now });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);

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
