// The wire format's limits (DESIGN.md "The wire format"): an insert carries at most 10,000 code points, a delete at
// most 1,000 spans of at most 10,000 ids, and counters stop at 2^53 - 1. A local edit of any size must still become
// operations every replica accepts, and a replica whose clock has run out must refuse to make more ids.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAX_INSERT_LENGTH,
  MAX_SPAN_LENGTH,
  MAX_SPANS,
  codePoints,
  type DeleteOp,
  type InsertOp,
  type Op,
} from '../src/protocol.ts';
import { Rga } from '../src/rga.ts';
import { replay } from './harness/changes.ts';
import { wire } from './harness/rga-subject.ts';

const MAX = Number.MAX_SAFE_INTEGER;

/** Sends operations through the codec to a fresh replica, which must end with the same state. */
function receivedBy(ops: readonly Op[], from: Rga): Rga {
  const to = new Rga('other');
  for (const op of ops) {
    const before = to.text();
    assert.equal(replay(before, to.apply(wire(op))), to.text());
  }
  assert.equal(to.state(), from.state());
  return to;
}

describe('a long paste', () => {
  test('becomes inserts of at most 10,000 code points, each after the last', () => {
    const rga = new Rga('a');
    const text = 'abcde'.repeat(5_000); // 25,000
    const ops = rga.edit(0, 0, text) as InsertOp[];
    assert.deepEqual(
      ops.map((op) => [op.id.counter, op.origin?.counter ?? null, codePoints(op.text)]),
      [
        [1, null, 10_000],
        [10_001, 10_000, 10_000],
        [20_001, 20_000, 5_000],
      ],
    );
    assert.equal(rga.text(), text);
    assert.equal(rga.clock, 25_000);
    const other = new Rga('b');
    for (const op of ops) other.apply(wire(op));
    assert.equal(other.state(), rga.state());
  });

  test('is split by code points, not UTF-16 units', () => {
    const rga = new Rga('a');
    rga.edit(0, 0, 'x');
    const ops = rga.edit(1, 0, '😀'.repeat(MAX_INSERT_LENGTH + 1)) as InsertOp[];
    assert.deepEqual(
      ops.map((op) => [op.id.counter, codePoints(op.text)]),
      [
        [2, MAX_INSERT_LENGTH],
        [MAX_INSERT_LENGTH + 2, 1],
      ],
    );
    assert.deepEqual(ops[0]?.origin, { replica: 'a', counter: 1 });
    receivedBy([...new Rga('a').edit(0, 0, 'x'), ...ops], rga);
  });

  test('of exactly 10,000 code points is one insert', () => {
    assert.equal(new Rga('a').edit(0, 0, 'a'.repeat(MAX_INSERT_LENGTH)).length, 1);
  });
});

describe('a large delete', () => {
  test('caps each span at 10,000 ids', () => {
    const rga = new Rga('a');
    const inserts = rga.edit(0, 0, 'a'.repeat(25_000));
    const [op, ...rest] = rga.edit(0, 25_000, '') as DeleteOp[];
    assert.equal(rest.length, 0);
    assert.deepEqual(op?.spans, [
      { replica: 'a', counter: 1, length: MAX_SPAN_LENGTH },
      { replica: 'a', counter: 10_001, length: MAX_SPAN_LENGTH },
      { replica: 'a', counter: 20_001, length: 5_000 },
    ]);
    assert.equal(rga.text(), '');
    receivedBy([...inserts, op], rga);
  });

  test('of more than 1,000 spans becomes several deletes', () => {
    const rga = new Rga('a');
    const ops: Op[] = [...rga.edit(0, 0, 'ab'.repeat(1_250))];
    // Delete every "b" (one edit each), so the 1,250 "a"s left have counters 1, 3, 5, ...: one span each.
    for (let i = 1; i <= 1_250; i++) ops.push(...rga.edit(i, 1, ''));
    assert.equal(rga.text(), 'a'.repeat(1_250));
    const deletes = rga.edit(0, 1_250, '') as DeleteOp[];
    assert.deepEqual(
      deletes.map((d) => d.spans.length),
      [MAX_SPANS, 250],
    );
    assert.deepEqual(deletes[1]?.spans[0], { replica: 'a', counter: 2_001, length: 1 });
    assert.equal(rga.text(), '');
    receivedBy([...ops, ...deletes], rga);
  });
});

describe('a clock near 2^53 - 1', () => {
  test('makes ids up to the last safe counter, then refuses to insert, changing nothing', () => {
    const rga = new Rga('a', { clock: MAX - 3 });
    const ops = rga.edit(0, 0, 'abc');
    assert.deepEqual(ops, [
      { type: 'insert', id: { replica: 'a', counter: MAX - 2 }, origin: null, text: 'abc' },
    ]);
    assert.equal(rga.clock, MAX);
    const state = rga.state();
    assert.throws(() => rga.edit(1, 0, 'x'), RangeError);
    assert.throws(
      () => rga.edit(0, 1, 'x'),
      RangeError,
      'a replace makes ids too, so it is refused whole',
    );
    assert.equal(rga.state(), state);
    // Deleting needs no ids.
    const deletion = rga.edit(0, 1, '');
    assert.equal(rga.text(), 'bc');
    receivedBy([...ops, ...deletion], rga);
  });

  test('is where a remote insert near the end of the range leaves it', () => {
    const rga = new Rga('b');
    rga.apply({ type: 'insert', id: { replica: 'a', counter: MAX - 1 }, origin: null, text: 'xy' });
    assert.equal(rga.clock, MAX);
    assert.throws(() => rga.edit(0, 0, 'z'), RangeError);
  });

  test("is not moved by a delete naming another replica's last counters (review 1)", () => {
    const rga = new Rga('c', { clock: 5 });
    rga.apply({ type: 'delete', spans: [{ replica: 'a', counter: MAX - 1, length: 2 }] });
    assert.equal(rga.clock, 5);
    assert.equal(rga.pending, 1);
    assert.deepEqual(rga.edit(0, 0, 'z'), [
      { type: 'insert', id: { replica: 'c', counter: 6 }, origin: null, text: 'z' },
    ]);
  });

  test('an edit that needs one counter more than is left is refused', () => {
    const rga = new Rga('a', { clock: MAX - 2 });
    assert.throws(() => rga.edit(0, 0, 'abc'), RangeError);
    assert.equal(rga.clock, MAX - 2);
    assert.equal(rga.edit(0, 0, 'ab').length, 1);
    assert.equal(rga.clock, MAX);
  });
});
