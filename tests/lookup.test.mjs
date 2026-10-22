// Tests for "Check my version" (src/assets/lookup.js): which release an input names and where it
// stands against the newest public release, counted the way Compare counts.
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const Lookup = createRequire(import.meta.url)('../src/assets/lookup.js');

const DAY = 864e5;
// Dotted-number order, for tests that give `judge` a version order.
const versionOrder = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
const T0 = Date.UTC(2026, 0, 1);
let n = 0;
// Newest first, as releases.js hands them over.
const rel = (version, build, stage, days, family = 'iOS', line) => ({
  ...(line ? { line } : {}),
  id: `${family}-${version}-${build}-${stage}-${n++}`,
  family,
  version,
  build,
  stage,
  major: parseInt(version, 10),
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

  it('takes a marketing name before the version', () => {
    assert.equal(Lookup.find(LIST, 'iOS Tahoe 27.0.1', 'iOS').build, '24A446');
    assert.equal(Lookup.find([rel('24H2', '26100', 'release', 1, 'Windows')], 'Windows 11 24H2', 'Windows').build, '26100');
  });

  it('takes a bare major only when every release of it has one version', () => {
    const android = [rel('16.0.0', 'BP4A', 'release', 9, 'Android'), rel('16.0.0', 'BP3A', 'release', 5, 'Android')];
    assert.equal(Lookup.find(android, '16', 'Android').build, 'BP4A');
    assert.equal(Lookup.find(android, 'Android 16', 'Android').build, 'BP4A');
    assert.equal(Lookup.find(android, '15', 'Android'), null);
    assert.equal(Lookup.find(LIST, '27'), null);
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
    const j = Lookup.judge(LIST, LIST[4]);
    assert.equal(j.kind, 'superseded');
    assert.equal(j.newest, LIST[1]);
    // 27.0.1 is public, the 27.1 beta is not.
    assert.deepEqual(j.between, [LIST[2], LIST[3]]);
    assert.equal(j.pub, 1);
    assert.equal(j.days, 20);
  });

  it('calls the newest release of an older major line current for that line', () => {
    const j = Lookup.judge(LIST, LIST[5]);
    assert.equal(j.kind, 'line');
    assert.equal(j.line, '26');
    assert.equal(j.newest, LIST[1]);
    assert.deepEqual(j.between, [LIST[2], LIST[3], LIST[4]]);
  });

  it('picks the newest by version, not by date, when it is given', () => {
    const higher = (a, b) => {
      const x = a.version.split('.').map(Number), y = b.version.split('.').map(Number);
      for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
      return false;
    };
    // A long-term release dated after a higher stable one, and an RC above both.
    const lts = rel('7.23.8', '7.23.8', 'release', 8, 'RouterOS');
    const rc = rel('7.25', '7.25rc1', 'rc', 1, 'RouterOS');
    const stable = rel('7.24.5', '7.24.5', 'release', 0, 'RouterOS');
    const list = [lts, rc, stable];
    const ctx = { newest: stable, higher };
    assert.equal(Lookup.judge(list, stable, ctx).kind, 'current');
    // Without lines (an older copy of the data) the major version is the line.
    const older = Lookup.judge(list, lts, ctx);
    assert.equal(older.kind, 'older');
    assert.equal(older.newest, stable);
    const ahead = Lookup.judge(list, rc, ctx);
    assert.equal(ahead.kind, 'ahead');
    assert.equal(ahead.newest, stable);
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
    const late = { ...rel('2.1', 'b', 'release', 1), t: T0 + DAY + 23 * 3600e3 };
    const early = { ...rel('2.0', 'a', 'release', 0), t: T0 + 3600e3 };
    const j = Lookup.judge([late, early], early);
    assert.equal(j.kind, 'superseded');
    assert.equal(j.days, 1);
  });

  it('cannot tell without a public release or for a release not in the list', () => {
    assert.equal(Lookup.judge([LIST[0]], LIST[0]).kind, 'none');
    assert.equal(Lookup.judge(LIST, rel('1', 'x', 'release', 0)).kind, 'none');
  });
});

describe('judge by line', () => {
  it('uses the line the data gives: a RouterOS channel is its own line', () => {
    const lts = rel('7.23.8', '7.23.8', 'release', 8, 'RouterOS', 'long-term');
    const rc = rel('7.25', '7.25rc1', 'rc', 1, 'RouterOS', 'testing');
    const stable = rel('7.24.5', '7.24.5', 'release', 0, 'RouterOS', 'stable');
    const older = rel('7.23.7', '7.23.7', 'release', -20, 'RouterOS', 'long-term');
    const list = [lts, rc, stable, older];
    const higher = (a, b) => versionOrder(a.version, b.version) > 0;
    const ctx = { newest: stable, higher };
    const j = Lookup.judge(list, lts, ctx);
    assert.equal(j.kind, 'line');
    assert.equal(j.line, 'long-term');
    assert.equal(j.newest, stable);
    // The older long-term release is superseded within its own line.
    const s = Lookup.judge(list, older, ctx);
    assert.equal(s.kind, 'superseded');
    assert.equal(s.lineNewest, lts);
    assert.equal(Lookup.judge(list, rc, ctx).kind, 'ahead');
  });

  it('keeps the Windows feature update as its line when the data has none', () => {
    const list = [rel('26H2', '26300.1', 'release', 5, 'Windows'), rel('25H2', '26200.1', 'release', 4, 'Windows')];
    assert.equal(Lookup.judge(list, list[1]).line, '25H2');
    const withLine = list.map((r) => ({ ...r, line: r.version }));
    assert.equal(Lookup.judge(withLine, withLine[1]).line, '25H2');
  });

  it('treats each Windows feature update as its own line', () => {
    const list = [rel('26H2', '26300.1', 'release', 5, 'Windows'), rel('25H2', '26200.1', 'release', 4, 'Windows')];
    const j = Lookup.judge(list, list[1]);
    assert.equal(j.kind, 'line');
    assert.equal(j.line, '25H2');
  });

  it('names the newest of its own line for a release that is superseded', () => {
    const list = [rel('27.1', 'a', 'release', 30), rel('26.7.1', 'b', 'release', 20), rel('26.7', 'c', 'release', 10)];
    const j = Lookup.judge(list, list[2]);
    assert.equal(j.kind, 'superseded');
    assert.equal(j.lineNewest, list[1]);
    assert.equal(Lookup.judge(LIST, LIST[3]).lineNewest, null);
  });
});

describe('behind', () => {
  it('places a version that is not in the data against the newest of its line', () => {
    const b = Lookup.behind(LIST, 'iOS 26.5', 'iOS');
    assert.equal(b.kind, 'line');
    assert.equal(b.line, '26');
    assert.equal(b.ref, LIST[5]);
    assert.equal(Lookup.behind(LIST, '27.0.0', 'iOS').ref, LIST[1]);
  });

  it('places a Windows build against the newest build of its version', () => {
    const list = [rel('24H2', '26100.9550', 'release', 1, 'Windows')];
    const b = Lookup.behind(list, 'Windows 26100.6584', 'Windows');
    assert.equal(b.kind, 'build');
    assert.equal(b.ref, list[0]);
  });

  it('says nothing for a version that is not older, a bare number or text', () => {
    assert.equal(Lookup.behind(LIST, '26.9', 'iOS'), null);
    assert.equal(Lookup.behind(LIST, '28.1', 'iOS'), null);
    assert.equal(Lookup.behind(LIST, '27', 'iOS'), null);
    assert.equal(Lookup.behind(LIST, 'nope', 'iOS'), null);
  });
});

describe('options', () => {
  it('lists the family releases in the list order, as build (else version) and label', () => {
    const o = Lookup.options(LIST, 'iOS');
    assert.deepEqual(o.map((x) => x.value), ['24B5099f', '24B80', '24B5001', '24A446', '24A340', '23G90']);
    assert.equal(o[1].label, '27.1 · 24B80');
    assert.equal(o[5].label, '26.6.2 · 23G90');
  });

  it('marks a pre-release with its stage', () => {
    const list = [
      rel('7.25', '7.25rc1', 'rc', 2, 'RouterOS'),
      rel('27.2', '24B5099f', 'beta', 1),
      rel('7.24.5', '7.24.5', 'release', 0, 'RouterOS'),
    ];
    assert.equal(Lookup.options(list, 'iOS')[0].label, '27.2 · 24B5099f (beta)');
    const ros = Lookup.options(list, 'RouterOS');
    assert.equal(ros[0].label, '7.25 · 7.25rc1 (rc)');
    assert.equal(ros[1].label, '7.24.5');
  });

  it('uses the version as the value and the whole label when there is no build, or it is the version', () => {
    const list = [rel('3.9.2', '', 'beta', 2, 'SteamOS'), rel('3.9.1', '3.9.1', 'release', 1, 'SteamOS')];
    assert.deepEqual(Lookup.options(list, 'SteamOS'), [
      { value: '3.9.2', label: '3.9.2 (beta)' },
      { value: '3.9.1', label: '3.9.1' },
    ]);
  });

  it('gives values that find() matches back to the same release', () => {
    Lookup.options(LIST, 'iOS').forEach((x, i) => assert.equal(Lookup.find(LIST, x.value, 'iOS'), LIST[i]));
  });

  it('keeps the first of two releases that share a value', () => {
    const list = [rel('26100.2', '26100', 'release', 3, 'Windows'), rel('26100.1', '26100', 'release', 1, 'Windows')];
    assert.deepEqual(Lookup.options(list, 'Windows'), [{ value: '26100', label: '26100.2 · 26100' }]);
  });

  it('leaves out other platforms and gives nothing for an empty family or list', () => {
    assert.deepEqual(Lookup.options(LIST, 'macOS'), []);
    assert.deepEqual(Lookup.options([], 'iOS'), []);
    assert.equal(Lookup.options([...LIST, rel('15.0', 'SP1A', 'release', 1, 'Android')], 'iOS').length, 6);
  });
});
