// Tests for the pure helpers behind the drawn devices on the front page (src/assets/below.js):
// the separator, the releases a device steps through and how a button or key moves along them.
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const { trail, steps, index, keeps, settle, move, keyStep, newest, blocked } = createRequire(
  import.meta.url,
)('../src/assets/below.js');

const row = (family, id, stage = 'release', version = '1', t = 0, beta = 0) => ({
  family,
  id,
  stage,
  version,
  t,
  beta,
});

describe('the separator after the stage', () => {
  it('follows the stage only when a build comes after it', () => {
    assert.equal(trail('Release', 'Build 25A5000'), 'Release ·');
    assert.equal(trail('Beta 3', 'Build 25A5000'), 'Beta 3 ·');
  });

  it('is never drawn next to an empty part', () => {
    assert.equal(trail('Release', ''), 'Release');
    assert.equal(trail('Release', undefined), 'Release');
    assert.equal(trail('Release', null), 'Release');
    assert.equal(trail('', 'Build 1'), '');
    assert.equal(trail('', ''), '');
  });
});

describe('the releases a device steps through', () => {
  const list = [
    row('SteamOS', 'a', 'beta', '3.9', 5),
    row('Android', 'x'),
    row('SteamOS', 'b', 'release', '3.8', 4),
    row('SteamOS', 'c', 'rc', '3.8', 3),
    row('SteamOS', 'd', 'release', '3.7', 2),
  ];

  it('are the public releases of its family, newest first', () => {
    assert.deepEqual(
      steps(list, 'SteamOS').map((r) => r.id),
      ['b', 'd'],
    );
  });

  it('are all of the family when none is public, and none when the family is absent', () => {
    const pre = [row('tvOS', 'p', 'beta', '27', 2), row('tvOS', 'q', 'rc', '27', 1)];
    assert.deepEqual(
      steps(pre, 'tvOS').map((r) => r.id),
      ['q', 'p'],
    );
    assert.deepEqual(steps(list, 'visionOS'), []);
  });

  it('can be only the pre-releases or everything, and fall back to the public ones', () => {
    assert.deepEqual(
      steps(list, 'SteamOS', 'pre').map((r) => r.id),
      ['a', 'c'],
    );
    assert.deepEqual(
      steps(list, 'SteamOS', 'all').map((r) => r.id),
      ['a', 'b', 'c', 'd'],
    );
    const none = [row('SteamOS', 'b', 'release', '3.8', 4)];
    assert.deepEqual(
      steps(none, 'SteamOS', 'pre').map((r) => r.id),
      ['b'],
    );
  });

  it('put the highest version first, not the latest date', () => {
    const ros = [
      row('RouterOS', 'low', 'release', '7.23.8', 9),
      row('RouterOS', 'high', 'release', '7.24.5', 1),
    ];
    assert.deepEqual(
      steps(ros, 'RouterOS').map((r) => r.id),
      ['high', 'low'],
    );
    assert.ok(newest(ros[1], ros[0]) < 0);
  });

  it('order Windows half-year versions and fall back to the date for a tie', () => {
    const win = [
      row('Windows', 'a', 'release', '25H2', 1),
      row('Windows', 'b', 'release', '26H1', 2),
      row('Windows', 'c', 'release', '25H2', 3),
    ];
    assert.deepEqual(
      steps(win, 'Windows').map((r) => r.id),
      ['b', 'c', 'a'],
    );
  });

  it('keep a position by release id and fall back to the newest', () => {
    const rows = steps(list, 'SteamOS');
    assert.equal(index(rows, 'd'), 1);
    assert.equal(index(rows, 'gone'), 0);
    assert.equal(index(rows, undefined), 0);
    assert.equal(index([], 'd'), 0);
  });

  it('keep the same release when a newer one is added in front', () => {
    const before = steps(list, 'SteamOS');
    const id = before[1].id;
    const after = steps([row('SteamOS', 'new', 'release', '4.0', 9), ...list], 'SteamOS');
    assert.equal(index(before, id), 1);
    assert.equal(index(after, id), 2);
    assert.equal(after[index(after, id)].id, id);
  });
});

describe('forgetting a pick that drops out', () => {
  const full = steps(
    [row('SteamOS', 'b', 'release', '3.8', 4), row('SteamOS', 'd', 'release', '3.7', 2)],
    'SteamOS',
  );

  it('knows whether a release is one of the steps', () => {
    assert.equal(keeps(full, 'd'), true);
    assert.equal(keeps(full, 'gone'), false);
    assert.equal(keeps(full, undefined), false);
    assert.equal(keeps([], 'd'), false);
  });

  it('clears the pick on an empty list so a later full list starts at the newest', () => {
    // settle() is what shown() in below.js calls as the time machine moves back and forth.
    const picked = { SteamOS: 'd' };
    const view = (rows) => settle(rows, picked, 'SteamOS');
    assert.equal(view(full), 1);
    assert.equal(view([]), 0);
    assert.equal(picked.SteamOS, undefined);
    assert.equal(view(full), 0);
  });
});

describe('moving along the steps', () => {
  it('goes one step either way', () => {
    assert.equal(move(2, 5, -1), 1);
    assert.equal(move(2, 5, 1), 3);
  });

  it('stops at both ends instead of wrapping', () => {
    assert.equal(move(0, 5, -1), 0);
    assert.equal(move(4, 5, 1), 4);
    assert.equal(move(0, 1, 1), 0);
  });

  it('jumps to the newest and the oldest', () => {
    assert.equal(move(3, 5, 'first'), 0);
    assert.equal(move(1, 5, 'last'), 4);
  });

  it('has nowhere to go without releases', () => {
    assert.equal(move(0, 0, 1), 0);
    assert.equal(move(0, 0, 'last'), 0);
  });
});

describe('the keys', () => {
  it('map the arrows to a step and Home and End to the ends', () => {
    assert.equal(keyStep('ArrowLeft'), -1);
    assert.equal(keyStep('ArrowRight'), 1);
    assert.equal(keyStep('Home'), 'first');
    assert.equal(keyStep('End'), 'last');
  });

  it('ignore every other key, including names an object inherits', () => {
    for (const key of ['ArrowUp', 'Enter', ' ', 'a', 'toString', 'constructor', '__proto__']) {
      assert.equal(keyStep(key), null, key);
    }
  });
});

describe('why a press cannot move', () => {
  it('says the first release is the newest and the last the oldest', () => {
    assert.equal(blocked(5, -1, false), 'Already the newest');
    assert.equal(blocked(5, 'first', false), 'Already the newest');
    assert.equal(blocked(5, 1, false), 'Already the oldest');
    assert.equal(blocked(5, 'last', false), 'Already the oldest');
  });

  it('says steps are paused on the Mac beta channel, whatever the key', () => {
    for (const by of [-1, 1, 'first', 'last']) {
      assert.equal(blocked(5, by, true), 'Steps are paused on the beta channel');
    }
  });

  it('says there is nothing to step through when there are no releases', () => {
    assert.equal(blocked(0, 1, false), 'No releases to step through');
  });
});
