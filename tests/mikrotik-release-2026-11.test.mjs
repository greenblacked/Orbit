// Regression coverage for the RouterOS 7.25.2/7.24.7 production release feeds.
// The timestamp in NEWESTa7 is the upstream build time, not the public announcement date.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

import { NEWEST_URLS, parse } from '../deploy/sources/mikrotik.js';

const snapshot = JSON.parse(readFileSync(new URL('../src/data/releases.json', import.meta.url), 'utf8'));
const versions = [
  { version: '7.25.2', channel: 'stable', buildTime: '2026-11-20T11:11:10Z' },
  { version: '7.24.7', channel: 'long-term', buildTime: '2026-11-19T08:42:49Z' },
];

for (const { version, channel, buildTime } of versions) {
  it(`parses RouterOS ${version} only on its own production channel`, () => {
    const response = `${version} ${Date.parse(buildTime) / 1000}\n`;
    const expected = `routeros-${version}-${channel}`;
    const parsed = parse(response, NEWEST_URLS[channel]);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, expected);
    assert.equal(parsed[0].stage, 'release');
    assert.equal(parsed[0].build, version);
    assert.equal(parsed[0].line, channel);
    assert.equal(parsed[0].date, buildTime);
    const otherChannel = channel === 'stable' ? 'long-term' : 'stable';
    // The feed URL, not the version text, determines whether a build is stable or long-term.
    assert.equal(parse(response, NEWEST_URLS[otherChannel])[0]?.line, otherChannel);
    assert.deepEqual(parse(response, NEWEST_URLS.testing), []);
  });

  it(`keeps RouterOS ${version} exactly once in the committed snapshot`, () => {
    const matches = snapshot.releases.filter((row) => row.id === `routeros-${version}-${channel}`);
    assert.equal(matches.length, 1);
    const [row] = matches;
    assert.equal(row.vendor, 'mikrotik');
    assert.equal(row.family, 'RouterOS');
    assert.equal(row.version, version);
    assert.equal(row.build, version);
    assert.equal(row.stage, 'release');
    assert.equal(row.line, channel);
    assert.equal(row.date, buildTime);
    assert.equal(row.url, `https://mikrotik.com/download?v=${version}`);
  });
}
