// The security notes payload: its contract (src/data/security.json) and the Worker route that
// serves it. The payload is snapshot-only: the Worker reads it from ASSETS and fetches nothing.
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createWorker } from '../deploy/worker.js';
import { fakeCtx, HEADERS_FILE, ORIGIN, state, stubUpstream, useHarness } from './support/harness.mjs';
import { problems } from './support/security_contract.mjs';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const security = JSON.parse(read('../src/data/security.json'));
const releases = JSON.parse(read('../src/data/releases.json')).releases;

describe('src/data/security.json', () => {
  it('has the payload shape and keeps to the contract', () => {
    assert.deepEqual(Object.keys(security), ['schema', 'generatedAt', 'sources', 'notes', 'releases']);
    assert.deepEqual(problems(security, releases), []);
  });

  it('keeps note titles free of entities and the site suffix', () => {
    for (const [url, note] of Object.entries(security.notes)) {
      for (const bad of ['&nbsp;', '&amp;', 'Android Open Source Project']) {
        assert.ok(!String(note.title).includes(bad), `${url} title contains ${bad}`);
      }
    }
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
        r1: {
          status: 'listed',
          notes: ['https://example.org/n'],
          cves: ['CVE-2026-0001'],
          count: 1,
          patchLevel: '2026-10-05',
        },
        b1: { status: 'not-applicable', notes: [], cves: [], count: null, patchLevel: null },
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
    for (const level of ['soon', '2026-13-01', '2026-02-30', '2026-10-5', 20261005, '']) {
      bad((p) => ((p.releases.r1.patchLevel = level), p), 'r1 has a bad patchLevel');
    }
    bad((p) => ((p.releases.b1.patchLevel = 'soon'), p), 'b1 has a bad patchLevel');
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
