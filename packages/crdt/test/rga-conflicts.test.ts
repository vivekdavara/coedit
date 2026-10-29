// Reused ids (DESIGN.md "Order of delivery, duplicates, and conflicts"): an insert that arrives again is a no-op,
// one that reuses a known id with other content is refused, and which of the two it is never depends on the order.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import type { Id, InsertOp } from '../src/protocol.ts';
import { ConflictError, Rga } from '../src/rga.ts';

const insert = (counter: number, replica: string, origin: Id | null, text: string): InsertOp => ({
  type: 'insert',
  id: { replica, counter },
  origin,
  text,
});

/** A replica holding "ab" from replica `a` (1@a, 2@a), then "c" after it (3@a) and "xy" from `b` (5-6@b). */
function holding(): Rga {
  const rga = new Rga('z');
  rga.apply(insert(1, 'a', null, 'ab'));
  rga.apply(insert(3, 'a', { replica: 'a', counter: 2 }, 'c'));
  rga.apply(insert(5, 'b', { replica: 'a', counter: 1 }, 'xy'));
  return rga;
}

/** Requires `op` to be refused with ConflictError on `id`, and the replica to be exactly as before. */
function refused(rga: Rga, op: InsertOp, id: Id): void {
  const state = rga.state();
  const clock = rga.clock;
  const pending = rga.pending;
  assert.throws(
    () => rga.apply(op),
    (error: unknown) => {
      assert.ok(error instanceof ConflictError, String(error));
      assert.deepEqual(error.id, id);
      return true;
    },
    JSON.stringify(op),
  );
  assert.equal(rga.state(), state);
  assert.equal(rga.clock, clock);
  assert.equal(rga.pending, pending);
}

describe('an insert reusing a known id', () => {
  test('is a duplicate only when it is the same run: same first id, origin and text', () => {
    const rga = holding();
    const state = rga.state();
    assert.deepEqual(rga.apply(insert(1, 'a', null, 'ab')), []);
    assert.deepEqual(rga.apply(insert(5, 'b', { replica: 'a', counter: 1 }, 'xy')), []);
    assert.equal(rga.state(), state);
  });

  test('with another character, is refused', () => {
    refused(holding(), insert(1, 'a', null, 'aX'), { replica: 'a', counter: 1 });
    refused(holding(), insert(3, 'a', { replica: 'a', counter: 2 }, 'C'), {
      replica: 'a',
      counter: 3,
    });
  });

  test('with another origin, is refused', () => {
    refused(holding(), insert(3, 'a', null, 'c'), { replica: 'a', counter: 3 });
    refused(holding(), insert(3, 'a', { replica: 'a', counter: 1 }, 'c'), {
      replica: 'a',
      counter: 3,
    });
  });

  test('as a longer or shorter run from the same id, is refused', () => {
    refused(holding(), insert(1, 'a', null, 'a'), { replica: 'a', counter: 1 });
    refused(holding(), insert(1, 'a', null, 'abc'), { replica: 'a', counter: 1 });
  });

  test('as part of a known run, or a run with a known part, is refused', () => {
    // Starts inside a known run, with exactly the content those elements have: still not that run.
    refused(holding(), insert(2, 'a', { replica: 'a', counter: 1 }, 'b'), {
      replica: 'a',
      counter: 2,
    });
    refused(holding(), insert(6, 'b', { replica: 'b', counter: 5 }, 'y'), {
      replica: 'b',
      counter: 6,
    });
    // New first id, known later ids: the first known one is named.
    refused(holding(), insert(4, 'b', null, 'wxy'), { replica: 'b', counter: 5 });
    refused(holding(), insert(4, 'b', null, 'wxyz'), { replica: 'b', counter: 5 });
  });

  test('against a run still waiting for its origin, is refused the same way', () => {
    const rga = new Rga('z');
    rga.apply(insert(5, 'a', { replica: 'q', counter: 4 }, 'xyz'));
    assert.equal(rga.pending, 1);
    assert.deepEqual(rga.apply(insert(5, 'a', { replica: 'q', counter: 4 }, 'xyz')), []);
    assert.equal(rga.pending, 1, 'a duplicate of a waiting run is not counted again');
    refused(rga, insert(5, 'a', { replica: 'q', counter: 4 }, 'xyZ'), { replica: 'a', counter: 5 });
    refused(rga, insert(6, 'a', null, 'y'), { replica: 'a', counter: 6 });
    refused(rga, insert(3, 'a', null, 'abc'), { replica: 'a', counter: 5 });
    // The waiting run still places normally afterwards.
    assert.deepEqual(rga.apply(insert(4, 'q', null, 'w')), [
      { type: 'insert', index: 0, text: 'w' },
      { type: 'insert', index: 1, text: 'xyz' },
    ]);
  });

  test('refused or not, the same way whichever of two inserts arrives first', () => {
    // Two inserts of one replica with counters 2 to 7; origins HEAD, an element of another replica (present
    // or not) or an earlier counter of the same replica. Applied to fresh replicas in both orders.
    const arbitraryInsert = fc
      .record(
        {
          counter: fc.integer({ min: 2, max: 5 }),
          text: fc.string({ unit: fc.constantFrom('a', 'b'), minLength: 1, maxLength: 3 }),
          origin: fc.oneof(fc.constant('head' as const), fc.constant('other' as const), fc.nat()),
        },
        { noNullPrototype: true },
      )
      .map(({ counter, text, origin }): InsertOp => {
        const id: Id | null =
          origin === 'head'
            ? null
            : origin === 'other'
              ? { replica: 'o', counter: 1 }
              : { replica: 'r', counter: 1 + (origin % (counter - 1)) };
        return insert(counter, 'r', id, text);
      });
    fc.assert(
      fc.property(arbitraryInsert, arbitraryInsert, fc.boolean(), (x, y, withOther) => {
        const ids = (op: InsertOp) => new Set(Array.from(op.text, (_, i) => op.id.counter + i));
        const overlap = [...ids(x)].some((c) => ids(y).has(c));
        const same = JSON.stringify(x) === JSON.stringify(y);
        for (const [first, second] of [
          [x, y],
          [y, x],
        ] as const) {
          const rga = new Rga('z');
          if (withOther) rga.apply(insert(1, 'o', null, 'o'));
          rga.apply(first);
          const state = rga.state();
          let conflict = false;
          try {
            rga.apply(second);
          } catch (error) {
            if (!(error instanceof ConflictError)) throw error;
            conflict = true;
          }
          assert.equal(
            conflict,
            overlap && !same,
            `${JSON.stringify(first)} then ${JSON.stringify(second)}`,
          );
          if (overlap) assert.equal(rga.state(), state);
        }
      }),
      { numRuns: 3_000 },
    );
  });
});
