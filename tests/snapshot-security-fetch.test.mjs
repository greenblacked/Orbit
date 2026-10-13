// The security snapshot reads pages one redirect at a time, only inside the adapter's allowlist.
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fetchPage, readPages } from '../deploy/snapshot_security.mjs';

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

  describe('English only', () => {
    const LANG = { param: 'hl', value: 'en' };
    const EN = `${START}?hl=en`;
    const withLang = (routes, calls, logs, headers = []) => ({
      ...OPTIONS(routes, calls, logs),
      lang: LANG,
      fetchImpl: async (url, init) => {
        headers.push(init.headers);
        return OPTIONS(routes, calls, logs).fetchImpl(url);
      },
    });

    it('adds hl=en to the request and keeps other query parameters', async () => {
      const calls = [];
      const html = await fetchPage(START, HOSTS, withLang({ [EN]: { html: 'en' } }, calls, []));
      assert.equal(html, 'en');
      assert.deepEqual(calls, [EN]);

      const other = [];
      const routes = { [`${START}?a=1&hl=en`]: { html: 'q' } };
      await fetchPage(`${START}?a=1`, HOSTS, withLang(routes, other, []));
      assert.deepEqual(other, [`${START}?a=1&hl=en`]);
    });

    it('does not touch the URL without a lang setting', async () => {
      const calls = [];
      await fetchPage(START, HOSTS, OPTIONS({ [START]: { html: 'x' } }, calls, []));
      assert.deepEqual(calls, [START]);
    });

    it('refuses a redirect to another hl', async () => {
      const calls = [];
      const routes = { [EN]: `${START}?hl=it`, [`${START}?hl=it`]: { html: 'it' } };
      await assert.rejects(fetchPage(START, HOSTS, withLang(routes, calls, [])), /redirected to a non-English variant/);
      assert.deepEqual(calls, [EN]);
    });

    it('follows a redirect to hl=en and to a page without hl', async () => {
      const target = 'https://source.android.com/docs/security/bulletin/2025/2025-01-01';
      const calls = [];
      const routes = { [EN]: `${target}?hl=en`, [`${target}?hl=en`]: { html: 'ok' } };
      assert.equal(await fetchPage(START, HOSTS, withLang(routes, calls, [])), 'ok');
      assert.deepEqual(calls, [EN, `${target}?hl=en`]);

      const bare = [];
      const routes2 = { [EN]: target, [`${target}?hl=en`]: { html: 'ok2' } };
      assert.equal(await fetchPage(START, HOSTS, withLang(routes2, bare, [])), 'ok2');
      assert.deepEqual(bare, [EN, `${target}?hl=en`]);
    });

    it('sends Accept-Language on every request', async () => {
      const headers = [];
      const routes = { [EN]: `${START}?hl=en&x=1`, [`${START}?hl=en&x=1`]: { html: 'x' } };
      await fetchPage(START, HOSTS, withLang(routes, [], [], headers));
      assert.equal(headers.length, 2);
      for (const h of headers) assert.equal(h['accept-language'], 'en-US,en;q=0.9');

      const plain = [];
      await fetchPage(START, HOSTS, {
        pauseMs: 0,
        log: () => {},
        fetchImpl: async (_url, init) => {
          plain.push(init.headers['accept-language']);
          return new Response('x', { status: 200, headers: { 'content-type': 'text/html' } });
        },
      });
      assert.deepEqual(plain, ['en-US,en;q=0.9']);
    });

    it('accepts hl=EN and hl=en-GB redirects', async () => {
      for (const variant of ['EN', 'en-GB']) {
        const target = `${START}/x?hl=${variant}`;
        const routes = { [EN]: target, [`${START}/x?hl=en`]: { html: 'ok' } };
        assert.equal(await fetchPage(START, HOSTS, withLang(routes, [], [])), 'ok');
      }
    });

    it('names a redirect that strips hl and so loops back to itself', async () => {
      const routes = { [EN]: START };
      await assert.rejects(fetchPage(START, HOSTS, withLang(routes, [], [])), /back to itself/);
    });

    it('keeps the canonical URL as the page key while the request carries hl=en', async () => {
      const calls = [];
      const cache = new Map();
      const pages = new Map();
      const adapter = { id: 'x', hosts: HOSTS, lang: LANG };
      await readPages(adapter, [START], cache, pages, withLang({ [EN]: { html: 'en' } }, calls, []));
      assert.deepEqual(calls, [EN]);
      assert.deepEqual([...pages.keys()], [START]);
      assert.deepEqual([...cache.keys()], [START]);
    });

    it('declares the parameter on the Android adapter only', async () => {
      const { SECURITY_SOURCES } = await import('../deploy/security/index.js');
      for (const adapter of SECURITY_SOURCES) {
        if (adapter.vendor === 'google') assert.deepEqual(adapter.lang, LANG);
        else assert.equal(adapter.lang, undefined);
      }
    });
  });
});
