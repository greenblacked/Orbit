// The security snapshot reads pages one redirect at a time, only inside the adapter's allowlist.
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fetchPage } from '../deploy/snapshot_security.mjs';

const HOSTS = ['source.android.com'];
const START = 'https://source.android.com/docs/security/bulletin/2025-01-01';
const OPTIONS = (routes, calls, logs) => ({
  pauseMs: 0,
  log: (line) => logs.push(line),
  fetchImpl: async (url) => {
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected request ${url}`);
    if (typeof route === 'string') {
      return new Response(null, { status: 302, headers: { location: route } });
    }
    return new Response(route.html, { status: 200, headers: { 'content-type': 'text/html' } });
  },
});

describe('snapshot_security fetchPage', () => {
  it('follows a same-host 302 and logs the hop', async () => {
    const target = 'https://source.android.com/docs/security/bulletin/2025/2025-01-01';
    const calls = [];
    const logs = [];
    const html = await fetchPage(START, HOSTS, OPTIONS({ [START]: target, [target]: { html: '<p>ok</p>' } }, calls, logs));
    assert.equal(html, '<p>ok</p>');
    assert.deepEqual(calls, [START, target]);
    assert.deepEqual(logs, [`followed redirect ${START} -> ${target}`]);
  });

  it('resolves a relative Location against the current URL', async () => {
    const target = 'https://source.android.com/docs/security/bulletin/2025/2025-01-01';
    const calls = [];
    const routes = { [START]: '2025/2025-01-01', [target]: { html: 'x' } };
    // "2025/2025-01-01" is relative to .../bulletin/, the directory of START.
    await fetchPage(START, HOSTS, OPTIONS(routes, calls, []));
    assert.deepEqual(calls, [START, target]);

    const absolutePath = { [START]: '/docs/security/bulletin/2025/2025-01-01', [target]: { html: 'x' } };
    const again = [];
    await fetchPage(START, HOSTS, OPTIONS(absolutePath, again, []));
    assert.deepEqual(again, [START, target]);
  });

  it('refuses a redirect to another host and names it', async () => {
    const calls = [];
    const routes = { [START]: 'https://evil.example/docs/security/bulletin/2025-01-01' };
    await assert.rejects(fetchPage(START, HOSTS, OPTIONS(routes, calls, [])), /evil\.example/);
    assert.deepEqual(calls, [START]);
  });

  it('refuses http, userinfo and a port', async () => {
    for (const bad of [
      'http://source.android.com/x',
      'https://user:pw@source.android.com/x',
      'https://source.android.com:8443/x',
    ]) {
      const calls = [];
      await assert.rejects(fetchPage(START, HOSTS, OPTIONS({ [START]: bad }, calls, [])), /not allowed/);
      assert.deepEqual(calls, [START]);
    }
  });

  it('refuses a protocol-relative and a trailing-dot Location', async () => {
    for (const bad of ['//evil.example/x', 'https://source.android.com./x']) {
      const calls = [];
      await assert.rejects(fetchPage(START, HOSTS, OPTIONS({ [START]: bad }, calls, [])), /not allowed/);
      assert.deepEqual(calls, [START]);
    }
  });

  it('refuses a 3xx without a Location', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return new Response(null, { status: 302 });
    };
    await assert.rejects(fetchPage(START, HOSTS, { pauseMs: 0, log: () => {}, fetchImpl }), /without a Location/);
    assert.deepEqual(calls, [START]);
  });

  it('refuses a loop and a chain over 3 redirects', async () => {
    const a = 'https://source.android.com/a';
    const b = 'https://source.android.com/b';
    const loopCalls = [];
    await assert.rejects(fetchPage(a, HOSTS, OPTIONS({ [a]: b, [b]: a }, loopCalls, [])), /more than 3 times/);
    assert.equal(loopCalls.length, 4);

    const chain = {};
    for (let i = 0; i < 5; i += 1) chain[`https://source.android.com/${i}`] = `https://source.android.com/${i + 1}`;
    chain['https://source.android.com/5'] = { html: 'x' };
    const chainCalls = [];
    await assert.rejects(fetchPage('https://source.android.com/0', HOSTS, OPTIONS(chain, chainCalls, [])), /more than 3 times/);
    assert.equal(chainCalls.length, 4);

    // Exactly 3 redirects is still fine.
    const three = {
      'https://source.android.com/0': 'https://source.android.com/1',
      'https://source.android.com/1': 'https://source.android.com/2',
      'https://source.android.com/2': 'https://source.android.com/3',
      'https://source.android.com/3': { html: 'done' },
    };
    assert.equal(await fetchPage('https://source.android.com/0', HOSTS, OPTIONS(three, [], [])), 'done');
  });
});
