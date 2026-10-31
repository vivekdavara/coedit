// Rga.ready and Rga.has: what the server checks before it accepts an operation (DESIGN.md "The sync protocol").
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import { ProtocolError, type DeleteOp, type InsertOp, type Span } from '../src/protocol.ts';
import { IdMap } from '../src/ids.ts';
import { Rga } from '../src/rga.ts';

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

describe('ready', () => {
  test('an insert is ready when its origin is HEAD or placed', () => {
    const rga = new Rga('s');
    assert.equal(rga.ready(insert(1, 'a', null, 'abc')), true);
    rga.apply(insert(1, 'a', null, 'abc'));
    assert.equal(rga.ready(insert(4, 'b', [3, 'a'], 'x')), true);
    assert.equal(rga.ready(insert(4, 'b', [1, 'a'], 'x')), true);
    assert.equal(rga.ready(insert(5, 'b', [4, 'a'], 'x')), false, 'past the end of the run');
    assert.equal(rga.ready(insert(5, 'b', [1, 'c'], 'x')), false, 'another replica');
  });

  test('an insert after a waiting element is not ready', () => {
    const rga = new Rga('s');
    rga.apply(insert(5, 'a', [4, 'z'], 'abc'));
    assert.equal(rga.has({ replica: 'a', counter: 6 }), true, 'held while waiting');
    assert.equal(rga.ready(insert(9, 'b', [6, 'a'], 'x')), false);
  });

  test('a delete is ready when every id it names is placed', () => {
    const rga = new Rga('s');
    rga.apply(insert(1, 'a', null, 'abc'));
    rga.apply(insert(4, 'a', [3, 'a'], 'def'));
    assert.equal(rga.ready(del([1, 'a', 6])), true, 'across two runs with consecutive counters');
    assert.equal(rga.ready(del([2, 'a', 1], [5, 'a', 2])), true);
    assert.equal(rga.ready(del([1, 'a', 7])), false, 'one past the last run');
    assert.equal(
      rga.ready(del([1, 'a', 1], [1, 'b', 1])),
      false,
      'a later span names a missing id',
    );
  });

  test("a delete over a gap in one replica's counters is not ready", () => {
    const rga = new Rga('s');
    rga.apply(insert(1, 'a', null, 'ab'));
    rga.apply(insert(10, 'a', [2, 'a'], 'cd'));
    assert.equal(rga.ready(del([1, 'a', 2], [10, 'a', 2])), true);
    assert.equal(rga.ready(del([2, 'a', 9])), false);
    assert.equal(rga.ready(del([3, 'a', 1])), false);
  });

  test('a delete naming a waiting element is not ready, nor one naming a deleted-ahead id', () => {
    const rga = new Rga('s');
    rga.apply(insert(5, 'a', [4, 'z'], 'abc'));
    rga.apply(del([1, 'q', 1]));
    assert.equal(rga.ready(del([5, 'a', 1])), false);
    assert.equal(rga.ready(del([1, 'q', 1])), false);
  });

  test('tombstones are placed: deleting them again is ready', () => {
    const rga = new Rga('s');
    rga.apply(insert(1, 'a', null, 'abc'));
    rga.apply(del([1, 'a', 3]));
    assert.equal(rga.ready(del([1, 'a', 3])), true);
    assert.equal(rga.ready(insert(4, 'b', [2, 'a'], 'x')), true);
  });

  test('refuses an operation that is not valid, and changes nothing', () => {
    const rga = new Rga('s');
    rga.apply(insert(1, 'a', null, 'abc'));
    const before = rga.state();
    assert.throws(() => rga.ready(insert(1, 'a', [1, 'a'], 'x')), ProtocolError);
    assert.throws(
      () => rga.ready({ type: 'delete', spans: [] } as unknown as DeleteOp),
      ProtocolError,
    );
    assert.equal(rga.state(), before);
  });

  test('checks a span run by run: one lookup per run, not one per id', () => {
    // A span of 10,000 ids over one run, a thousand times: id by id that's 10 million lookups (about 110 ms here,
    // too close to anything a time limit could tell apart on a slow runner, so the lookups are counted).
    const rga = new Rga('s');
    rga.apply(insert(1, 'a', null, 'x'.repeat(10_000)));
    rga.apply(insert(10_001, 'a', [10_000, 'a'], 'y'.repeat(10_000)));
    const spans: [number, string, number][] = [];
    for (let i = 0; i < 1_000; i++) spans.push([1, 'a', 10_000]);
    const proto = IdMap.prototype as IdMap<unknown>;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- put back in `finally`, and called with its this
    const get = proto.get;
    let lookups = 0;
    proto.get = function (this: IdMap<unknown>, id) {
      lookups++;
      return get.call(this, id);
    };
    try {
      assert.equal(rga.ready(del(...spans)), true);
      assert.equal(lookups, 1_000);
      lookups = 0;
      // Two runs per span.
      assert.equal(rga.ready(del([5_000, 'a', 10_000], [1, 'a', 10_000])), true);
      assert.equal(lookups, 3);
    } finally {
      proto.get = get;
    }
  });

  test('agrees with checking id by id, on generated documents and spans', () => {
    // Runs of two replicas with gaps in their counters, some of them waiting on an origin that never arrives,
    // and deletes naming spans anywhere around them.
    const run = fc.record({
      replica: fc.constantFrom('a', 'b'),
      gap: fc.integer({ min: 1, max: 3 }),
      length: fc.integer({ min: 1, max: 4 }),
      waits: fc.boolean(),
    });
    const span = fc.record({
      replica: fc.constantFrom('a', 'b', 'c'),
      counter: fc.integer({ min: 1, max: 40 }),
      length: fc.integer({ min: 1, max: 12 }),
    });
    fc.assert(
      fc.property(
        fc.array(run, { maxLength: 12 }),
        fc.array(span, { minLength: 1, maxLength: 4 }),
        (runs, spans: Span[]) => {
          const rga = new Rga('s');
          const next = { a: 0, b: 0 };
          for (const r of runs) {
            const counter = Math.max(next.a, next.b) + r.gap;
            next[r.replica] = counter + r.length - 1;
            // A waiting run's origin is an id no run here has.
            const origin = r.waits && counter > 1 ? { replica: 'z', counter: counter - 1 } : null;
            rga.apply({
              type: 'insert',
              id: { replica: r.replica, counter },
              origin,
              text: 'x'.repeat(r.length),
            });
          }
          const op: DeleteOp = { type: 'delete', spans };
          let expected = true;
          for (const s of spans) {
            for (let i = 0; i < s.length; i++) {
              if (rga.indexAfter({ replica: s.replica, counter: s.counter + i }) === undefined)
                expected = false;
            }
          }
          assert.equal(rga.ready(op), expected);
        },
      ),
      { numRuns: 2_000 },
    );
  });
});
