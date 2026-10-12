// The security notes payload: its contract (src/data/security.json) and the Worker route that
// serves it. The payload is snapshot-only: the Worker reads it from ASSETS and fetches nothing.
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createWorker } from '../deploy/worker.js';
import { fakeCtx, HEADERS_FILE, ORIGIN, state, stubUpstream, useHarness } from './support/harness.mjs';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const security = JSON.parse(read('../src/data/security.json'));
const releases = JSON.parse(read('../src/data/releases.json')).releases;

const STATUSES = [
  'listed',
  'no-cve-entries',
  'not-found',
  'not-applicable',
  'unavailable',
  'not-connected',
];
const CVE = /^CVE-\d{4}-\d{4,}$/;

// A real https URL: the prefix alone would accept "https://" or "https://[bad".
function isHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}

const sortedUnique = (list) => list.every((item, i) => i === 0 || list[i - 1] < item);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Every problem a payload has against `rows` (the releases it may describe); empty when valid.
// A release key must already be in releases.json: live releases can run ahead of the snapshot,
// so notes for a newer release wait until `node deploy/snapshot_releases.mjs` has run.
function problems(payload, rows) {
  const found = [];
  const stages = new Map(rows.map((row) => [row.id, row.stage]));
  if (payload.schema !== 1) found.push('schema must be 1');
  if (typeof payload.generatedAt !== 'string' || !Number.isFinite(Date.parse(payload.generatedAt))) {
    found.push('generatedAt is not a date');
  }
  for (const key of ['sources', 'notes', 'releases']) {
    if (!isObject(payload[key])) found.push(`${key} is not an object`);
  }
  if (found.length > 0) return found;
  for (const [url, note] of Object.entries(payload.notes)) {
    if (!isHttpsUrl(url)) found.push(`note ${url} is not https`);
    if (!isObject(note)) {
      found.push(`note ${url} is not an object`);
      continue;
    }
    if (!(note.source in payload.sources)) found.push(`note ${url} names an unknown source`);
    const ids = Array.isArray(note.cves) ? note.cves.map((cve) => cve?.id) : null;
    if (!ids || !ids.every((id) => typeof id === 'string' && CVE.test(id))) {
      found.push(`note ${url} has a bad CVE`);
    } else if (!sortedUnique(ids)) {
      found.push(`note ${url}: cves are not sorted and unique`);
    }
  }
  for (const [id, entry] of Object.entries(payload.releases)) {
    if (!isObject(entry)) {
      found.push(`${id} is not an object`);
      continue;
    }
    const stage = stages.get(id);
    if (stage === undefined) found.push(`${id} is not in releases.json`);
    if (!STATUSES.includes(entry.status)) found.push(`${id} has status ${entry.status}`);
    const listsNotes = entry.status === 'listed' || entry.status === 'no-cve-entries';
    if (listsNotes && stage !== 'release') found.push(`${id} lists notes but is a ${stage}`);
    if (stage && stage !== 'release' && entry.status !== 'not-applicable') {
      found.push(`${id} is a ${stage} and must be not-applicable`);
    }
    if (!Array.isArray(entry.notes) || !Array.isArray(entry.cves)) {
      found.push(`${id}: notes and cves must be arrays`);
      continue;
    }
    const known = new Set();
    for (const url of entry.notes) {
      if (!isHttpsUrl(url)) found.push(`${id} names a note that is not https`);
      if (!(url in payload.notes)) found.push(`${id} names a note that is missing: ${url}`);
      else for (const cve of payload.notes[url].cves ?? []) known.add(cve?.id);
    }
    if (!sortedUnique(entry.notes)) found.push(`${id}: notes are not sorted and unique`);
    if (!sortedUnique(entry.cves)) found.push(`${id}: cves are not sorted and unique`);
    for (const cve of entry.cves) {
      if (typeof cve !== 'string' || !CVE.test(cve)) found.push(`${id} has a bad CVE ${cve}`);
      else if (!known.has(cve)) found.push(`${id} lists ${cve} that its notes do not`);
    }
    if (entry.status === 'listed') {
      if (entry.notes.length === 0) found.push(`${id} is listed without notes`);
      if (entry.cves.length === 0) found.push(`${id} is listed without cves`);
      if (entry.count !== entry.cves.length) found.push(`${id}: count does not match cves`);
    } else if (entry.status === 'no-cve-entries') {
      if (entry.cves.length > 0 || entry.count !== 0) found.push(`${id} must have no cves and count 0`);
    } else if (entry.notes.length > 0 || entry.cves.length > 0 || entry.count !== null) {
      found.push(`${id} must have no notes or cves and count null`);
    }
  }
  return found;
}

describe('src/data/security.json', () => {
  it('has the payload shape and keeps to the contract', () => {
    assert.deepEqual(Object.keys(security), ['schema', 'generatedAt', 'sources', 'notes', 'releases']);
    assert.deepEqual(problems(security, releases), []);
  });

  it('is rejected by the contract when it breaks an invariant', () => {
    const rows = [
      { id: 'r1', stage: 'release' },
      { id: 'b1', stage: 'beta' },
    ];
    const good = {
      schema: 1,
      generatedAt: '2026-10-12T09:00:00Z',
      sources: { s: {} },
      notes: { 'https://example.org/n': { source: 's', cves: [{ id: 'CVE-2026-0001' }] } },
      releases: {
        r1: { status: 'listed', notes: ['https://example.org/n'], cves: ['CVE-2026-0001'], count: 1 },
        b1: { status: 'not-applicable', notes: [], cves: [], count: null },
      },
    };
    assert.deepEqual(problems(good, rows), []);
    // Each mutation breaks one invariant; the message must name that invariant.
    const bad = (change, message) => {
      const found = problems(change(structuredClone(good)), rows);
      assert.ok(
        found.some((line) => line.includes(message)),
        `expected "${message}" in ${JSON.stringify(found)}`,
      );
    };
    const note = 'https://example.org/n';
    bad((p) => ((p.schema = 2), p), 'schema must be 1');
    bad((p) => ((p.generatedAt = 'yesterday'), p), 'generatedAt is not a date');
    bad((p) => ((p.sources = []), p), 'sources is not an object');
    bad((p) => ((p.releases.nope = p.releases.r1), p), 'nope is not in releases.json');
    bad((p) => ((p.releases.r1.status = 'new'), p), 'r1 has status new');
    bad((p) => ((p.releases.b1.status = 'listed'), p), 'b1 lists notes but is a beta');
    for (const status of ['unavailable', 'not-found', 'not-connected']) {
      bad((p) => ((p.releases.b1.status = status), p), 'b1 is a beta and must be not-applicable');
    }
    bad((p) => ((p.releases.r1.notes = ['https://example.org/other']), p), 'note that is missing');
    bad((p) => ((p.releases.r1.notes = []), p), 'r1 is listed without notes');
    bad((p) => ((p.releases.r1.cves = []), p), 'r1 is listed without cves');
    bad((p) => ((p.releases.r1.count = 2), p), 'count does not match cves');
    bad((p) => ((p.releases.r1.notes = null), p), 'notes and cves must be arrays');
    bad((p) => ((p.releases.r1.cves = ['CVE-2026-0002', 'CVE-2026-0001']), p), 'cves are not sorted');
    bad((p) => ((p.releases.r1.cves = ['CVE-2026-0001', 'CVE-2026-0001']), p), 'cves are not sorted');
    bad((p) => ((p.releases.r1.cves = ['CVE-2026-0009']), p), 'lists CVE-2026-0009 that its notes do not');
    bad((p) => ((p.releases.r1.cves = ['nope']), p), 'r1 has a bad CVE nope');
    bad((p) => ((p.releases.b1.count = 0), p), 'b1 must have no notes or cves and count null');
    bad((p) => ((p.releases.b1.notes = [note]), p), 'b1 must have no notes or cves and count null');
    bad((p) => ((p.notes['http://example.org/n'] = p.notes[note]), p), 'is not https');
    bad((p) => ((p.releases.r1.notes = ['http://example.org/n']), p), 'names a note that is not https');
    for (const key of ['https://', 'https://[bad']) {
      bad((p) => ((p.notes[key] = p.notes[note]), p), 'is not https');
      bad((p) => ((p.releases.r1.notes = [key]), p), 'names a note that is not https');
    }
    bad((p) => ((p.releases.r1.notes = [42]), p), 'names a note that is not https');
    bad((p) => ((p.notes[note] = 'x'), p), 'is not an object');
    bad((p) => ((p.notes[note].source = 'other'), p), 'unknown source');
    bad((p) => ((p.notes[note].cves = [{ id: 'CVE-1' }]), p), 'has a bad CVE');
    bad((p) => ((p.notes[note].cves = [{ id: 'CVE-2026-0002' }, { id: 'CVE-2026-0001' }]), p), 'cves are not sorted');
    bad((p) => {
      p.notes['https://example.org/a'] = p.notes[note];
      p.releases.r1.notes = [note, 'https://example.org/a'];
      return p;
    }, 'notes are not sorted');
    bad((p) => ((p.releases.r1 = 'x'), p), 'r1 is not an object');
  });
});

// An ASSETS binding that serves `body` at /data/security.json with `status`.
function envWith(body, status = 200) {
  const calls = [];
  return {
    calls,
    ASSETS: {
      async fetch(input) {
        const path = new URL(input instanceof Request ? input.url : input).pathname;
        calls.push(path);
        return path === '/data/security.json'
          ? new Response(body, { status })
          : new Response('asset', { status: 200 });
      },
    },
  };
}

describe('the Worker: /api/security.json', () => {
  useHarness();
  const worker = createWorker([]);
  const call = (path, env, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env, fakeCtx());
  const text = JSON.stringify(security);

  it('serves the bundled payload unchanged in content, and fetches nothing', async () => {
    stubUpstream(() => {
      throw new Error('no upstream fetch is allowed');
    });
    const env = envWith(text);
    const res = await call('/api/security.json', env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), security);
    assert.deepEqual(env.calls, ['/data/security.json']);
    assert.equal(state.upstream.calls.length, 0);
  });

  it('sets the header set of src/_headers and the API cache policy', async () => {
    const csp = /^ {2}Content-Security-Policy: (.+)$/m.exec(HEADERS_FILE)[1];
    const res = await call('/api/security.json', envWith(text));
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('content-security-policy'), csp);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(res.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('answers HEAD with the headers and no body', async () => {
    const res = await call('/api/security.json', envWith(text), { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  });

  it('answers 405 to anything but GET and HEAD', async () => {
    const res = await call('/api/security.json', envWith(text), { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
  });

  it('answers 503 with no-store when the asset is missing, broken or not an object', async () => {
    for (const env of [envWith('', 404), envWith('not json'), envWith('[]'), envWith('null')]) {
      for (const method of ['GET', 'HEAD']) {
        const res = await call('/api/security.json', env, { method });
        assert.equal(res.status, 503);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.match(res.headers.get('content-type'), /^application\/json/);
        if (method === 'GET') assert.ok((await res.json()).error);
      }
    }
  });

  it('leaves the other paths alone', async () => {
    assert.equal((await call('/api/security', envWith(text))).status, 404);
    assert.equal((await call('/api/security.json/x', envWith(text))).status, 404);
  });
});
