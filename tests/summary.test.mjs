// Tests for the optional release `summary`: its cleaning rules and the owner's notes laid
// over a release list (deploy/releases.js). node:test and node:assert only.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SUMMARY_MAX, applyNotes, backfillLine, cleanSummary, withSummary } from '../deploy/releases.js';

const release = (id, extra = {}) => ({ id, title: `Release ${id}`, ...extra });

describe('cleanSummary', () => {
  it('gives an empty string for anything that is not text', () => {
    for (const value of [undefined, null, 4, {}, [], true]) assert.equal(cleanSummary(value), '');
  });

  it('trims, collapses whitespace and turns line breaks into spaces', () => {
    assert.equal(cleanSummary('  one \n\n two\t three \r\n'), 'one two three');
  });

  it('removes control characters', () => {
    assert.equal(cleanSummary('a\u0000b\u0007c\u007fd\u009fe'), 'abcde');
  });

  it('removes zero-width, bidi and byte-order-mark characters', () => {
    assert.equal(cleanSummary('a\u200bb\u202ec\u2066d\u2069e\ufefff\u200fg'), 'abcdefg');
    assert.equal(cleanSummary('\ufeff\u202e'), '');
  });

  it('never ends a hard cut on half of a surrogate pair', () => {
    const out = cleanSummary('x'.repeat(198) + '\u{1F600}'.repeat(5));
    assert.ok(out.length <= SUMMARY_MAX);
    assert.equal(out, 'x'.repeat(198) + '\u2026');
  });

  it('leaves nothing for a string of only whitespace and controls', () => {
    assert.equal(cleanSummary(' \n\u0000\t '), '');
  });

  it('keeps text up to the limit exactly as it is', () => {
    const text = 'x'.repeat(SUMMARY_MAX);
    assert.equal(cleanSummary(text), text);
  });

  it('cuts longer text at a word and ends it with an ellipsis, within the limit', () => {
    const text = 'word '.repeat(80);
    const out = cleanSummary(text);
    assert.ok(out.length <= SUMMARY_MAX);
    assert.ok(out.endsWith('…'));
    assert.match(out, /^(?:word )*word…$/);
  });

  it('cuts a text with no usable space at the limit', () => {
    const out = cleanSummary('y'.repeat(500));
    assert.equal(out.length, SUMMARY_MAX);
    assert.ok(out.endsWith('…'));
  });

  it('does not leave a dangling comma or full stop before the ellipsis', () => {
    const out = cleanSummary(`${'ab '.repeat(66)}end, ${'z'.repeat(40)}`);
    assert.ok(out.length <= SUMMARY_MAX);
    assert.doesNotMatch(out, /[,.;:\s]…$/);
  });

  it('is idempotent', () => {
    const once = cleanSummary('word '.repeat(80));
    assert.equal(cleanSummary(once), once);
  });

  it('does not strip markup: it is plain text that pages write with textContent', () => {
    assert.equal(cleanSummary('<b>bold</b>'), '<b>bold</b>');
  });
});

describe('withSummary', () => {
  it('adds the cleaned summary without changing the release', () => {
    const base = release('a');
    assert.deepEqual(withSummary(base, ' hello  world '), { ...base, summary: 'hello world' });
    assert.equal(base.summary, undefined);
  });

  it('returns the release itself when nothing is left of the text', () => {
    const base = release('a', { summary: 'kept' });
    assert.equal(withSummary(base, '  '), base);
    assert.equal(withSummary(base, 7), base);
  });
});

describe('applyNotes', () => {
  const list = [release('a'), release('b', { summary: 'from source' }), release('c')];

  it('lays a note over the release it names, and wins over a source summary', () => {
    const out = applyNotes(list, { schema: 1, notes: { a: 'Note A', b: 'Note B' } });
    assert.equal(out[0].summary, 'Note A');
    assert.equal(out[1].summary, 'Note B');
    assert.equal(out[2].summary, undefined);
  });

  it('keeps a source summary when the note is empty after cleaning', () => {
    assert.equal(applyNotes(list, { notes: { b: ' ' } })[1].summary, 'from source');
  });

  it('ignores notes for releases that are not in the list', () => {
    assert.deepEqual(applyNotes(list, { notes: { zzz: 'nobody' } }), list);
  });

  it('does not read inherited keys', () => {
    assert.deepEqual(applyNotes([release('toString')], { notes: {} }), [release('toString')]);
  });

  it('changes nothing for a payload that is not a notes document', () => {
    for (const payload of [null, undefined, 'x', [], {}, { notes: [] }, { notes: 'x' }]) {
      assert.equal(applyNotes(list, payload), list);
    }
  });

  it('does not change the list it was given', () => {
    const copy = JSON.parse(JSON.stringify(list));
    applyNotes(list, { notes: { a: 'Note A' } });
    assert.deepEqual(list, copy);
  });
});

describe('backfillLine', () => {
  it('gives a cached RouterOS row the channel at the end of its id', () => {
    for (const channel of ['stable', 'long-term', 'testing']) {
      const out = backfillLine({ id: `routeros-7.23.8-${channel}`, family: 'RouterOS', version: '7.23.8' });
      assert.equal(out.line, channel);
    }
    assert.equal(backfillLine({ id: 'routeros-7.23.8', family: 'RouterOS' }).line, undefined);
  });

  it('gives a cached Windows feature update its version as the line', () => {
    assert.equal(backfillLine({ id: 'w#24h2-1', family: 'Windows', version: '24H2' }).line, '24H2');
    assert.equal(backfillLine({ id: 'w#x', family: 'Windows', version: '22621' }).line, undefined);
  });

  it('keeps a line that is already there', () => {
    const row = { id: 'routeros-7.23.8-stable', family: 'RouterOS', line: 'testing' };
    assert.equal(backfillLine(row), row);
    const win = { id: 'w#1', family: 'Windows', version: '24H2', line: '23H2' };
    assert.equal(backfillLine(win).line, '23H2');
  });

  it('adds no line to other families', () => {
    const row = { id: 'ios-26-stable', family: 'iOS', version: '26H2' };
    assert.equal(backfillLine(row), row);
    assert.equal('line' in backfillLine(row), false);
  });
});
