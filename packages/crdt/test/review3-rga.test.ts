// Review 3 of day 2 (on 55dec77..c7c6237, round 2's fixes): its findings, each of which failed before its fix.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeleteOp, InsertOp } from '../src/protocol.ts';
import { Rga } from '../src/rga.ts';

const del = (...spans: [number, string, number][]): DeleteOp => ({
  type: 'delete',
  spans: spans.map(([counter, replica, length]) => ({ replica, counter, length })),
});

const waiting = (counter: number, replica: string, text: string): InsertOp => ({
  type: 'insert',
  id: { replica, counter },
  origin: { replica: 'q', counter: 1 },
  text,
});

// Finding 1 (fixed by lowering MAX_CAPACITY to 2^23 - 1, see its comment): a Map that has lost entries can refuse
// a set with as few as 2^23 + 1 live entries, so a capacity of 2^24 - 1 didn't keep #deletedAhead or
// #waitingDeletes (both lose entries) from throwing halfway. Its reproduction needs millions of entries and about
// 1.6 GB; it passes now (run as a one-off), and these tests pin the boundaries of the checks around it.

// Four mutants of round 2's checks survived its tests.
test('a delete that exactly fills the capacity with ids ahead is accepted', () => {
  const rga = new Rga('r', { capacity: 2 });
  rga.apply(del([1, 'a', 1]));
  rga.apply(del([1, 'a', 1], [2, 'a', 1]));
  assert.equal(rga.sizes().deletedAhead, 2);
  assert.equal(rga.pending, 2);
});

test('a delete one id past the capacity is refused, also when it names few ids', () => {
  const rga = new Rga('r', { capacity: 2 });
  rga.apply(del([1, 'a', 1]));
  const state = rga.state();
  assert.throws(() => rga.apply(del([5, 'a', 2])), RangeError);
  assert.equal(rga.state(), state);
});

test('a waiting delete resent at the capacity for waiting deletes is a duplicate, not refused', () => {
  const rga = new Rga('r', { capacity: 1 });
  rga.apply(del([1, 'a', 1]));
  assert.deepEqual(rga.apply(del([1, 'a', 1])), []);
  assert.equal(rga.pending, 1);
});

test('sizes() counts waiting runs, not the origins they wait on', () => {
  const rga = new Rga('r');
  rga.apply(waiting(5, 'x', 'a'));
  rga.apply(waiting(6, 'y', 'b'));
  assert.equal(rga.sizes().waitingRuns, 2);
  assert.equal(rga.pending, 2);
});

// Review 4: the capacity getter was checked only at its default, so returning MAX_CAPACITY always passed.
test('the capacity getter reports the capacity the replica was given', () => {
  assert.equal(new Rga('r', { capacity: 5 }).capacity, 5);
});
