// Review 2 of day 2 (on 0cbad60..55dec77): its findings, each of which failed before its fix.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DeleteOp, InsertOp } from '../src/protocol.ts';
import { MAX_CAPACITY, Rga } from '../src/rga.ts';

const del = (...spans: [number, string, number][]): DeleteOp => ({
  type: 'delete',
  spans: spans.map(([counter, replica, length]) => ({ replica, counter, length })),
});

const insert = (counter: number, replica: string, text: string): InsertOp => ({
  type: 'insert',
  id: { replica, counter },
  origin: null,
  text,
});

/** Requires `act` to throw RangeError and leave the replica exactly as it was. */
function refused(rga: Rga, act: () => unknown): void {
  const before = [rga.state(), rga.clock, rga.pending, rga.length];
  assert.throws(act, RangeError);
  assert.deepEqual([rga.state(), rga.clock, rga.pending, rga.length], before);
}

// Finding 1: a V8 Map holds at most 2^24 entries, and the id maps keep one Map per replica. Two valid deletes of
// 10 million absent ids each overflowed the deleted-ahead map partway through the second: apply threw after
// recording about 6.8 million of its ids, before counting it as waiting, so it was half applied (an insert it
// named then arrived deleted) and invisible to `pending`. The replica now refuses, before changing anything, any
// operation that would hold more elements, ids deleted ahead or waiting deletes than its capacity (2^24 - 1 by
// default; 2^23 - 1 since review 3). Tests use a small capacity; `npm run worst-delete -w @coedit/crdt -- 800 twice`
// tries the real one.
describe('the capacity', () => {
  test('defaults to the most a Map holds, and must be from 1 to that', () => {
    assert.equal(MAX_CAPACITY, 8_388_607);
    assert.equal(new Rga('a').capacity, MAX_CAPACITY);
    for (const capacity of [0, -1, 1.5, MAX_CAPACITY + 1, Number.NaN]) {
      assert.throws(() => new Rga('a', { capacity }), RangeError, String(capacity));
    }
    assert.equal(new Rga('a', { capacity: MAX_CAPACITY }).length, 0);
  });

  test('refuses an insert that would hold too many elements, whole, and still accepts its duplicates', () => {
    const rga = new Rga('r', { capacity: 5 });
    rga.apply(insert(1, 'a', 'abc'));
    rga.apply({
      type: 'insert',
      id: { replica: 'b', counter: 9 },
      origin: { replica: 'q', counter: 1 },
      text: 'xy',
    });
    assert.equal(rga.pending, 1, 'waiting elements count too');
    refused(rga, () => rga.apply(insert(4, 'a', 'd')));
    assert.deepEqual(rga.apply(insert(1, 'a', 'abc')), []);
    // Deleting frees nothing (tombstones stay), so the replica is full.
    rga.edit(0, 3, '');
    refused(rga, () => rga.apply(insert(4, 'a', 'd')));
  });

  test('refuses a local edit whole, its deletes included', () => {
    const rga = new Rga('a', { capacity: 4 });
    rga.edit(0, 0, 'abc');
    refused(rga, () => rga.edit(0, 2, 'xy'));
    assert.equal(rga.text(), 'abc');
    assert.equal(rga.edit(0, 2, 'x').length, 2);
    assert.equal(rga.text(), 'xc');
  });

  test('refuses a delete that would record too many ids ahead, its present ids untouched', () => {
    const rga = new Rga('r', { capacity: 6 });
    rga.apply(insert(1, 'a', 'ab'));
    rga.apply(del([10, 'a', 3]));
    assert.equal(rga.pending, 1);
    // Names a present id and 2 new absent ones: 3 + 2 would be 5, within 6 ...
    rga.apply(del([1, 'a', 1], [20, 'a', 2]));
    assert.equal(rga.text(), 'b');
    // ... and then 2 more absent ones would make 7: refused, so "b" (2@a) stays.
    refused(rga, () => rga.apply(del([2, 'a', 1], [30, 'a', 2])));
    assert.equal(rga.text(), 'b');
    // Ids already deleted ahead add nothing: another delete waiting on them is accepted.
    rga.apply(del([10, 'a', 2]));
    assert.equal(rga.pending, 3);
  });

  test('refuses another waiting delete past the capacity', () => {
    const rga = new Rga('r', { capacity: 2 });
    rga.apply(del([1, 'a', 1]));
    rga.apply(del([1, 'a', 1], [1, 'a', 1]));
    assert.equal(rga.pending, 2);
    refused(rga, () => rga.apply(del([1, 'a', 1], [1, 'a', 1], [1, 'a', 1])));
    // A delete of present elements makes no wait, so it's still accepted.
    rga.apply(insert(5, 'b', 'x'));
    rga.apply(del([5, 'b', 1]));
    assert.equal(rga.text(), '');
  });

  test('refuses another waiting delete even when it names few ids', () => {
    // Three deletes wait on the one id 1@a (three keys, one id ahead). A fourth naming 1@a and 2@a would add
    // only one id ahead, well within 3, but a fourth waiting delete: the shortcut must not skip that check.
    const rga = new Rga('r', { capacity: 3 });
    rga.apply(del([1, 'a', 1]));
    rga.apply(del([1, 'a', 1], [1, 'a', 1]));
    rga.apply(del([1, 'a', 1], [1, 'a', 1], [1, 'a', 1]));
    assert.equal(rga.pending, 3);
    refused(rga, () => rga.apply(del([1, 'a', 2])));
  });
});

// A surviving mutant of review 2: keying a waiting delete by the set of ids it names rather than by its spans.
// pending counts operations, and two deletes naming the same ids through different spans are two operations
// (no generated session makes such a pair, so nothing else pinned it).
test('two deletes naming the same missing ids through different spans count as two', () => {
  const rga = new Rga('r');
  rga.apply(del([1, 'a', 2]));
  rga.apply(del([1, 'a', 1], [2, 'a', 1]));
  rga.apply(del([2, 'a', 1], [1, 'a', 1]));
  assert.equal(rga.pending, 3);
  rga.apply(del([1, 'a', 1], [2, 'a', 1]));
  assert.equal(rga.pending, 3, 'the same spans again are the same operation');
  rga.apply(insert(1, 'a', 'xy'));
  assert.equal(rga.pending, 0);
  assert.equal(rga.text(), '');
});
