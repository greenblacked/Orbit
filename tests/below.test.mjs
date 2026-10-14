// Tests for the pure helpers behind the drawn devices on the front page (src/assets/below.js):
// the separator, the releases a device steps through and how a button or key moves along them.
// node --test 'tests/*.test.mjs'    (node:test and node:assert only; nothing to install)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const { trail, steps, index, move, keyStep } = createRequire(import.meta.url)(
  '../src/assets/below.js',
);

const row = (family, id, stage = 'release') => ({ family, id, stage });

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
    row('SteamOS', 'a', 'beta'),
    row('Android', 'x'),
    row('SteamOS', 'b'),
    row('SteamOS', 'c', 'rc'),
    row('SteamOS', 'd'),
  ];

  it('are the public releases of its family, in the order given (newest first)', () => {
    assert.deepEqual(
      steps(list, 'SteamOS').map((r) => r.id),
      ['b', 'd'],
    );
  });

  it('are all of the family when none is public, and none when the family is absent', () => {
    const pre = [row('tvOS', 'p', 'beta'), row('tvOS', 'q', 'rc')];
    assert.deepEqual(
      steps(pre, 'tvOS').map((r) => r.id),
      ['p', 'q'],
    );
    assert.deepEqual(steps(list, 'visionOS'), []);
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
    const after = steps([row('SteamOS', 'new'), ...list], 'SteamOS');
    assert.equal(index(before, id), 1);
    assert.equal(index(after, id), 2);
    assert.equal(after[index(after, id)].id, id);
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
