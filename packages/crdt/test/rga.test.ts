// RGA, one behaviour at a time (DESIGN.md "The CRDT: RGA"). The convergence properties over generated schedules
// are in rga-convergence.test.ts.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ProtocolError, type DeleteOp, type InsertOp, type Op } from '../src/protocol.ts';
import { Rga, type Change } from '../src/rga.ts';
import { replay } from './harness/changes.ts';

const insert = (
  counter: number,
  replica: string,
  origin: [number, string] | null,
  text: string,
): InsertOp => ({
  type: 'insert',
  id: { replica, counter },
  origin: origin === null ? null : { counter: origin[0], replica: origin[1] },
  text,
});

const del = (...spans: [counter: number, replica: string, length: number][]): DeleteOp => ({
  type: 'delete',
  spans: spans.map(([counter, replica, length]) => ({ replica, counter, length })),
});

/** Applies an operation and checks its changes against the text before and after. */
function apply(rga: Rga, op: Op): Change[] {
  const before = rga.text();
  const changes = rga.apply(op);
  assert.equal(replay(before, changes), rga.text(), `changes ${JSON.stringify(changes)}`);
  return changes;
}

describe('a new replica', () => {
  test('is empty, with its clock at 0 unless told otherwise', () => {
    const rga = new Rga('a');
    assert.equal(rga.text(), '');
    assert.equal(rga.length, 0);
    assert.equal(rga.clock, 0);
    assert.equal(rga.pending, 0);
    assert.equal(new Rga('a', { clock: 2 ** 40 }).clock, 2 ** 40);
  });

  test('refuses a replica id the wire format would refuse, and a bad clock', () => {
    for (const name of ['', 'a b', 'é', 'x'.repeat(33), 'a.b']) {
      assert.throws(() => new Rga(name), RangeError, name);
    }
    assert.equal(new Rga('x'.repeat(32)).replica, 'x'.repeat(32));
    for (const clock of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      assert.throws(() => new Rga('a', { clock }), RangeError, String(clock));
    }
  });
});

describe('local edits', () => {
  test('apply at once and return a delete, then an insert after the element before the index', () => {
    const rga = new Rga('a');
    assert.deepEqual(rga.edit(0, 0, 'hello'), [insert(1, 'a', null, 'hello')]);
    assert.equal(rga.text(), 'hello');
    assert.equal(rga.length, 5);
    assert.equal(rga.clock, 5);
    // Replace "ll" by "LL!": delete 3@a and 4@a, insert after 2@a ("e").
    assert.deepEqual(rga.edit(2, 2, 'LL!'), [del([3, 'a', 2]), insert(6, 'a', [2, 'a'], 'LL!')]);
    assert.equal(rga.text(), 'heLL!o');
    assert.equal(rga.clock, 8);
    assert.deepEqual(rga.edit(0, 1, ''), [del([1, 'a', 1])]);
    assert.equal(rga.text(), 'eLL!o');
    assert.deepEqual(rga.edit(5, 0, '.'), [insert(9, 'a', [5, 'a'], '.')]);
    assert.equal(rga.text(), 'eLL!o.');
    assert.deepEqual(rga.edit(3, 0, ''), []);
    assert.equal(rga.text(), 'eLL!o.');
  });

  test('count code points, not UTF-16 units', () => {
    const rga = new Rga('a');
    rga.edit(0, 0, 'a😀b');
    assert.equal(rga.length, 3);
    assert.equal(rga.clock, 3);
    rga.edit(1, 1, '');
    assert.equal(rga.text(), 'ab');
    const ops = rga.edit(1, 0, 'é😀');
    assert.deepEqual(ops, [insert(4, 'a', [1, 'a'], 'é😀')]);
    assert.equal(rga.text(), 'aé😀b');
  });

  test('delete spans of consecutive counters, one per stretch', () => {
    const rga = new Rga('a');
    rga.edit(0, 0, 'abcd'); // 1-4
    rga.edit(2, 0, 'XY'); // 5-6 between b and c
    assert.equal(rga.text(), 'abXYcd');
    assert.deepEqual(rga.edit(1, 4, ''), [del([2, 'a', 1], [5, 'a', 2], [3, 'a', 1])]);
    assert.equal(rga.text(), 'ad');
    // "a" and "d" are 1@a and 4@a: not consecutive counters, so two spans.
    assert.deepEqual(rga.edit(0, 2, ''), [del([1, 'a', 1], [4, 'a', 1])]);
    assert.equal(rga.text(), '');
  });

  test('refuse positions outside the text and lone surrogates, changing nothing', () => {
    const rga = new Rga('a');
    rga.edit(0, 0, 'abc');
    const state = rga.state();
    const bad: [number, number, string][] = [
      [-1, 0, 'x'],
      [4, 0, 'x'],
      [0.5, 0, 'x'],
      [Number.NaN, 0, 'x'],
      [1, 3, ''],
      [0, -1, ''],
      [0, 1.5, ''],
      [1, 0, '\ud800'],
      [1, 1, 'a\udc00'],
    ];
    for (const [index, deleteCount, text] of bad) {
      assert.throws(
        () => rga.edit(index, deleteCount, text),
        RangeError,
        `${index} ${deleteCount}`,
      );
      assert.equal(rga.state(), state);
      assert.equal(rga.clock, 3);
    }
  });

  test('return operations the caller can change without changing the replica', () => {
    const rga = new Rga('a');
    const [op] = rga.edit(0, 0, 'ab') as [InsertOp];
    (op as { text: string }).text = 'zz';
    (op.id as { counter: number }).counter = 50;
    assert.equal(rga.text(), 'ab');
    assert.deepEqual(rga.apply(insert(1, 'a', null, 'ab')), []);
  });
});

describe('remote operations', () => {
  test('give the same text, and report it as visible changes', () => {
    const a = new Rga('a');
    const b = new Rga('b');
    const ops = [...a.edit(0, 0, 'hello'), ...a.edit(1, 3, 'EL')];
    assert.deepEqual(apply(b, ops[0] as Op), [{ type: 'insert', index: 0, text: 'hello' }]);
    assert.deepEqual(apply(b, ops[1] as Op), [{ type: 'delete', index: 1, count: 3 }]);
    assert.deepEqual(apply(b, ops[2] as Op), [{ type: 'insert', index: 1, text: 'EL' }]);
    assert.equal(b.text(), 'hELo');
    assert.equal(b.state(), a.state());
    // The Lamport clock: b has seen counters up to 7.
    assert.equal(b.clock, 7);
    assert.deepEqual(b.edit(0, 0, 'x'), [insert(8, 'b', null, 'x')]);
  });

  test('place concurrent inserts at one spot by id, larger first, on every replica', () => {
    const a = new Rga('a');
    const b = new Rga('b');
    const fromA = a.edit(0, 0, 'xx');
    const fromB = b.edit(0, 0, 'yy');
    // Both runs start at counter 1, so the replica decides: "b" > "a", b's run goes first.
    for (const op of fromB) apply(a, op);
    for (const op of fromA) apply(b, op);
    assert.equal(a.text(), 'yyxx');
    assert.equal(b.text(), 'yyxx');
    assert.equal(a.state(), b.state());
  });

  test('skip the whole subtree of a larger insert, not only the insert', () => {
    // r types "ab" (1-2). s, having seen it, types "S" after "a" (3@s), then "Z" after S (4@s). Concurrently t,
    // having seen only "ab", types "T" after "a" (3@t), then "U" after T (4@t). 3@t > 3@s, so T goes first with
    // its subtree (U), then S with its own (Z): the scan for S skips T and U, both larger.
    const r = new Rga('r');
    const s = new Rga('s');
    const t = new Rga('t');
    const base = r.edit(0, 0, 'ab');
    for (const op of base) {
      apply(s, op);
      apply(t, op);
    }
    const fromS = [...s.edit(1, 0, 'S'), ...s.edit(2, 0, 'Z')];
    const fromT = [...t.edit(1, 0, 'T'), ...t.edit(2, 0, 'U')];
    assert.equal(s.text(), 'aSZb');
    assert.equal(t.text(), 'aTUb');
    for (const op of fromT) apply(s, op);
    for (const op of fromS) apply(t, op);
    for (const op of [...fromS, ...fromT]) apply(r, op);
    for (const replica of [r, s, t]) assert.equal(replica.text(), 'aTUSZb');
    assert.equal(s.state(), r.state());
    assert.equal(t.state(), r.state());
  });

  test('keep tombstones, so an insert after a deleted element still finds its place', () => {
    const a = new Rga('a');
    const b = new Rga('b');
    for (const op of a.edit(0, 0, 'ab')) apply(b, op);
    const deleteA = a.edit(0, 1, ''); // a deletes "a"
    const insertB = b.edit(1, 0, 'X'); // b, not having seen it, types after "a"
    for (const op of insertB) apply(a, op);
    for (const op of deleteA) apply(b, op);
    assert.equal(a.text(), 'Xb');
    assert.equal(b.text(), 'Xb');
    assert.equal(a.state(), b.state());
    assert.match(a.state(), /^1@a<HEAD~"a" 3@b<1@a"X" 2@a"b" \|/);
  });

  test('report a delete of scattered elements as one change per stretch, each after the last', () => {
    const a = new Rga('a');
    const b = new Rga('b');
    for (const op of a.edit(0, 0, 'abcdef')) apply(b, op);
    // b deletes "b" and "c"; then a deletes "a b c d" and "f" (knowing nothing of b's delete).
    for (const op of b.edit(1, 2, '')) apply(a, op);
    assert.equal(a.text(), 'adef');
    const changes = apply(b, del([1, 'a', 4], [6, 'a', 1]));
    // On b ("adef"): "a" at 0, "d" at 1 (b and c are tombstones there already), then "f" at 3, now at 1.
    assert.deepEqual(changes, [
      { type: 'delete', index: 0, count: 2 },
      { type: 'delete', index: 1, count: 1 },
    ]);
    assert.equal(b.text(), 'e');
  });

  test('ignore duplicates: an insert or delete applied again changes nothing', () => {
    const a = new Rga('a');
    const b = new Rga('b');
    const ops = [...a.edit(0, 0, 'abc'), ...a.edit(1, 1, '')];
    for (const op of ops) apply(b, op);
    const state = b.state();
    for (const op of [...ops, ...ops]) {
      assert.deepEqual(apply(b, op), []);
      assert.equal(b.state(), state);
      assert.equal(b.pending, 0);
    }
    // And a replica's own operations, echoed back.
    for (const op of ops) assert.deepEqual(apply(a, op), []);
    assert.equal(a.state(), state);
  });

  test('refuse an operation the wire format would refuse, changing nothing', () => {
    const b = new Rga('b');
    apply(b, insert(1, 'a', null, 'ab'));
    const state = b.state();
    const bad: unknown[] = [
      insert(2, 'a', [2, 'a'], 'x'), // counter not above its origin's
      insert(3, 'a', [5, 'a'], 'x'),
      insert(3, 'a', null, '\ud800'),
      insert(3, 'a', null, ''),
      insert(3, 'a b', null, 'x'),
      insert(0, 'a', null, 'x'),
      { type: 'delete', spans: [] },
      { type: 'delete', spans: [{ replica: 'a', counter: 1, length: 0 }] },
      { type: 'insert', id: { replica: 'a', counter: 3 }, origin: null, text: 'x', extra: 1 },
      { type: 'move' },
    ];
    for (const op of bad) {
      assert.throws(() => b.apply(op as Op), ProtocolError, JSON.stringify(op));
      assert.equal(b.state(), state);
      assert.equal(b.clock, 2);
    }
  });
});

describe('operations that arrive before their dependencies', () => {
  test('an insert waits for its origin, then both show', () => {
    const a = new Rga('a');
    const b = new Rga('b');
    const first = a.edit(0, 0, 'ab');
    const second = a.edit(2, 0, 'c');
    assert.deepEqual(apply(b, second[0] as Op), []);
    assert.equal(b.pending, 1);
    assert.equal(b.text(), '');
    assert.deepEqual(apply(b, first[0] as Op), [
      { type: 'insert', index: 0, text: 'ab' },
      { type: 'insert', index: 2, text: 'c' },
    ]);
    assert.equal(b.pending, 0);
    assert.equal(b.state(), a.state());
  });

  test('a chain of waiting inserts is placed in one go when its root arrives', () => {
    const a = new Rga('a');
    const ops = [
      ...a.edit(0, 0, 'a'),
      ...a.edit(1, 0, 'b'),
      ...a.edit(2, 0, 'c'),
      ...a.edit(1, 0, 'X'),
    ];
    const b = new Rga('b');
    for (const op of ops.slice(1).reverse()) assert.deepEqual(apply(b, op), []);
    assert.equal(b.pending, 3);
    const changes = apply(b, ops[0] as Op);
    assert.equal(changes.length, 4);
    assert.equal(b.text(), 'aXbc');
    assert.equal(b.pending, 0);
    assert.equal(b.state(), a.state());
  });

  test('a delete of ids not yet here waits; the insert then arrives as a tombstone', () => {
    const a = new Rga('a');
    const b = new Rga('b');
    const ops = [...a.edit(0, 0, 'abc'), ...a.edit(0, 2, '')];
    assert.deepEqual(apply(b, ops[1] as Op), []);
    assert.equal(b.pending, 1);
    assert.equal(b.clock, 2, 'the clock covers ids named by a delete too');
    // The insert's change shows only the element not deleted.
    assert.deepEqual(apply(b, ops[0] as Op), [{ type: 'insert', index: 0, text: 'c' }]);
    assert.equal(b.pending, 0);
    assert.equal(b.text(), 'c');
    assert.equal(b.state(), a.state());
  });

  test('a delete of a waiting insert needs nothing more, and counts once however often it arrives', () => {
    const a = new Rga('a');
    const b = new Rga('b');
    const ops = [...a.edit(0, 0, 'ab'), ...a.edit(2, 0, 'cd'), ...a.edit(1, 3, '')];
    const [first, second, deletion] = ops as [Op, Op, Op];
    apply(b, second); // waits for "ab"
    apply(b, deletion); // names 2 (unknown) and 3-4 (waiting)
    apply(b, deletion);
    assert.equal(b.pending, 2);
    assert.match(b.state(), /waiting 3@a<2@a~"c" 4@a~"d" \| deleted ahead 2@a$/);
    assert.deepEqual(apply(b, first), [{ type: 'insert', index: 0, text: 'a' }]);
    assert.equal(b.pending, 0);
    assert.equal(b.text(), 'a');
    assert.equal(b.state(), a.state());
  });

  test('two deletes naming the same missing id each wait for all of their own', () => {
    const b = new Rga('b');
    apply(b, del([1, 'a', 2]));
    apply(b, del([2, 'a', 2]));
    assert.equal(b.pending, 2);
    apply(b, insert(1, 'a', null, 'ab'));
    assert.equal(b.pending, 1, 'the second still waits for 3@a');
    apply(b, insert(3, 'a', [2, 'a'], 'c'));
    assert.equal(b.pending, 0);
    assert.equal(b.text(), '');
  });

  test('a delete naming only ids another waiting delete names still counts, in either order', () => {
    for (const order of [
      [del([1, 'a', 2]), del([2, 'a', 1])],
      [del([2, 'a', 1]), del([1, 'a', 2])],
    ]) {
      const b = new Rga('b');
      for (const op of order) apply(b, op);
      assert.equal(b.pending, 2, JSON.stringify(order));
      apply(b, insert(2, 'a', null, 'x'));
      assert.equal(b.pending, 1, 'only the delete of 1@a and 2@a waits now');
      assert.equal(b.text(), '');
    }
  });

  test('a delete naming a missing id twice waits for it once', () => {
    const b = new Rga('b');
    apply(b, del([1, 'a', 2], [2, 'a', 1]));
    assert.equal(b.pending, 1);
    apply(b, insert(1, 'a', null, 'ab'));
    assert.equal(b.pending, 0);
  });
});

describe('state()', () => {
  test('writes every element, the waiting runs and the ids deleted ahead', () => {
    const b = new Rga('b');
    apply(b, insert(1, 'a', null, 'xy'));
    apply(b, del([1, 'a', 1]));
    apply(b, insert(9, 'c', [8, 'c'], 'w'));
    apply(b, insert(5, 'c', [4, 'z'], 'v'));
    apply(b, del([7, 'q', 2]));
    assert.equal(
      b.state(),
      '1@a<HEAD~"x" 2@a"y" | waiting 5@c<4@z"v", 9@c<8@c"w" | deleted ahead 7@q 8@q',
    );
  });
});
