// Tests for "Check my version" (src/assets/lookup.js): which release an input names and where it
// stands against the newest public release, counted the way Compare counts.
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const Lookup = createRequire(import.meta.url)('../src/assets/lookup.js');

const DAY = 864e5;
const T0 = Date.UTC(2026, 0, 1);
let n = 0;
// Newest first, as releases.js hands them over.
const rel = (version, build, stage, days, family = 'iOS') => ({
  id: `${family}-${version}-${build}-${stage}-${n++}`,
  family,
  version,
  build,
  stage,
  t: T0 + days * DAY + 3600e3,
});
const LIST = [
  rel('27.2', '24B5099f', 'beta', 40),
  rel('27.1', '24B80', 'release', 30),
  rel('27.1', '24B5001', 'beta', 25),
  rel('27.0.1', '24A446', 'release', 20),
  rel('27.0', '24A340', 'release', 10),
  rel('26.6.2', '23G90', 'release', 4),
];

describe('find', () => {
  it('matches a version or a build, ignoring case and spacing', () => {
    assert.equal(Lookup.find(LIST, '24a446').version, '27.0.1');
    assert.equal(Lookup.find(LIST, '  27.0  ').build, '24A340');
    assert.equal(Lookup.find(LIST, '26.6.2').build, '23G90');
  });

  it('prefers the release when a beta shares the version', () => {
    assert.equal(Lookup.find(LIST, '27.1').stage, 'release');
    assert.equal(Lookup.find(LIST, '24B5001').stage, 'beta');
  });

  it('takes the platform name in front of the version', () => {
    assert.equal(Lookup.find(LIST, 'iOS 27.0.1', 'iOS').build, '24A446');
    assert.equal(Lookup.find(LIST, 'ios   27.0', 'iOS').build, '24A340');
  });

  it('wants the whole version or build, not a prefix or part of one', () => {
    assert.equal(Lookup.find(LIST, '27'), null);
    assert.equal(Lookup.find(LIST, '24A4'), null);
    assert.equal(Lookup.find(LIST, '27.0.1.1'), null);
  });

  it('finds nothing for an empty or unknown input', () => {
    assert.equal(Lookup.find(LIST, ''), null);
    assert.equal(Lookup.find(LIST, '   '), null);
    assert.equal(Lookup.find(LIST, undefined), null);
    assert.equal(Lookup.find(LIST, 'nope'), null);
    assert.equal(Lookup.find([], '27.0'), null);
  });
});

describe('judge', () => {
  it('calls the newest public release current, even with a newer beta', () => {
    const j = Lookup.judge(LIST, LIST[1]);
    assert.equal(j.kind, 'current');
    assert.equal(j.newest, LIST[1]);
  });

  it('calls a beta that is newer than the newest public release ahead', () => {
    const j = Lookup.judge(LIST, LIST[0]);
    assert.equal(j.kind, 'ahead');
    assert.equal(j.newest, LIST[1]);
  });

  it('counts only the public releases between, and the days from the newest', () => {
    const j = Lookup.judge(LIST, LIST[5]);
    assert.equal(j.kind, 'superseded');
    assert.equal(j.newest, LIST[1]);
    // 27.0.1 and 27.0 are public, the 27.1 beta is not.
    assert.deepEqual(j.between, [LIST[2], LIST[3], LIST[4]]);
    assert.equal(j.pub, 2);
    assert.equal(j.days, 26);
  });

  it('counts none between neighbours, and a beta that was superseded', () => {
    const next = Lookup.judge(LIST, LIST[3]);
    assert.equal(next.kind, 'superseded');
    assert.equal(next.pub, 0);
    assert.equal(next.days, 10);
    const old = Lookup.judge(LIST, LIST[2]);
    assert.equal(old.kind, 'superseded');
    assert.equal(old.pub, 0);
    assert.equal(old.days, 5);
  });

  it('counts calendar days, not elapsed hours', () => {
    const late = { ...rel('2', 'b', 'release', 1), t: T0 + DAY + 23 * 3600e3 };
    const early = { ...rel('1', 'a', 'release', 0), t: T0 + 3600e3 };
    const j = Lookup.judge([late, early], early);
    assert.equal(j.days, 1);
  });

  it('cannot tell without a public release or for a release not in the list', () => {
    assert.equal(Lookup.judge([LIST[0]], LIST[0]).kind, 'none');
    assert.equal(Lookup.judge(LIST, rel('1', 'x', 'release', 0)).kind, 'none');
  });
});
