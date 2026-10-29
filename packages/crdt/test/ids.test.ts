// The id order directly (DESIGN.md "Testing convergence", day 2): within one process a comparator used
// consistently converges whatever order it gives, so these tests are what pins the order the spec names.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import { IdMap, compareIds, formatId, sameId } from '../src/ids.ts';
import type { Id } from '../src/protocol.ts';
import { REPLICA_NAMES } from './harness/network.ts';

const MAX = Number.MAX_SAFE_INTEGER;

/** UTF-16 code-unit order, written out one unit at a time: the reference the comparator must match. */
function codeUnitOrder(a: string, b: string): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

describe('compareIds', () => {
  test("orders the simulator's replica names by code unit, not by locale or creation", () => {
    const ids = REPLICA_NAMES.map((replica) => ({ replica, counter: 7 }));
    const sorted = [...ids].sort(compareIds).map((id) => id.replica);
    assert.deepEqual(sorted, ['B', 'Z', 'a_', 'b', 'm', 'mm']);
    // The names were chosen so that the other plausible orders all differ from it.
    const byLocale = [...REPLICA_NAMES].sort((a, b) => a.localeCompare(b));
    assert.notDeepEqual(byLocale, sorted);
    assert.notDeepEqual([...REPLICA_NAMES], sorted);
  });

  test('orders by counter first, whatever the replicas', () => {
    assert.ok(compareIds({ counter: 1, replica: 'z' }, { counter: 2, replica: 'A' }) < 0);
    assert.ok(compareIds({ counter: 10, replica: 'A' }, { counter: 9, replica: 'z' }) > 0);
    // Numerically, not as text: "10" < "9" as strings.
    assert.ok(compareIds({ counter: 9, replica: 'a' }, { counter: 10, replica: 'a' }) < 0);
  });

  test('is exact at the ends of the counter range', () => {
    const at = (counter: number, replica = 'a'): Id => ({ counter, replica });
    assert.ok(compareIds(at(MAX), at(MAX - 1)) > 0);
    assert.ok(compareIds(at(MAX - 1), at(MAX)) < 0);
    assert.ok(compareIds(at(1), at(MAX)) < 0);
    assert.equal(compareIds(at(MAX), at(MAX)), 0);
    assert.ok(compareIds(at(MAX, 'b'), at(MAX, 'a')) > 0);
    // Past 2^31, where storing counters in 32 bits (`| 0`, Int32Array) wraps negative.
    assert.ok(compareIds(at(2 ** 31), at(2 ** 31 - 1)) > 0);
    assert.ok(compareIds(at(2 ** 32 + 1), at(2)) > 0);
  });

  test('agrees with counter-then-code-unit order on any ids', () => {
    const replica = fc.oneof(
      fc.constantFrom(...REPLICA_NAMES),
      fc.stringMatching(/^[A-Za-z0-9_-]{1,4}$/),
    );
    const counter = fc.oneof(
      fc.integer({ min: 1, max: 4 }),
      fc.integer({ min: MAX - 3, max: MAX }),
    );
    const id = fc.record({ replica, counter }, { noNullPrototype: true });
    fc.assert(
      fc.property(id, id, (a, b) => {
        const expected =
          a.counter === b.counter
            ? sign(codeUnitOrder(a.replica, b.replica))
            : a.counter < b.counter
              ? -1
              : 1;
        assert.equal(sign(compareIds(a, b)), expected);
        assert.equal(sign(compareIds(b, a)), sign(-expected));
        assert.equal(compareIds(a, b) === 0, sameId(a, b));
      }),
      { numRuns: 2_000 },
    );
  });
});

describe('sameId and formatId', () => {
  test('treat null as HEAD', () => {
    assert.ok(sameId(null, null));
    assert.ok(!sameId(null, { counter: 1, replica: 'a' }));
    assert.ok(!sameId({ counter: 1, replica: 'a' }, null));
    assert.ok(!sameId({ counter: 1, replica: 'a' }, { counter: 1, replica: 'A' }));
    assert.equal(formatId(null), 'HEAD');
    assert.equal(formatId({ counter: 12, replica: 'mm' }), '12@mm');
  });
});

describe('IdMap', () => {
  test('keeps one entry per id and lists them in id order', () => {
    const map = new IdMap<string>();
    map.set({ counter: 2, replica: 'b' }, 'x');
    map.set({ counter: 2, replica: 'B' }, 'y');
    map.set({ counter: 1, replica: 'b' }, 'z');
    map.set({ counter: 2, replica: 'b' }, 'x2');
    assert.equal(map.size, 3);
    assert.equal(map.get({ counter: 2, replica: 'b' }), 'x2');
    assert.ok(map.has({ counter: 2, replica: 'B' }));
    assert.ok(!map.has({ counter: 3, replica: 'b' }));
    assert.equal(map.get({ counter: 1, replica: 'zz' }), undefined);
    assert.deepEqual(map.ids().map(formatId), ['1@b', '2@B', '2@b']);
    assert.ok(map.delete({ counter: 2, replica: 'B' }));
    assert.ok(!map.delete({ counter: 2, replica: 'B' }));
    assert.ok(!map.delete({ counter: 9, replica: 'q' }));
    assert.equal(map.size, 2);
    assert.deepEqual(map.ids().map(formatId), ['1@b', '2@b']);
  });

  test('matches a Map keyed by strings under any sequence of operations', () => {
    const id = fc.record(
      { replica: fc.constantFrom('a', 'b', 'B'), counter: fc.integer({ min: 1, max: 4 }) },
      { noNullPrototype: true },
    );
    const action = fc.oneof(
      fc.record(
        { kind: fc.constant('set' as const), id, value: fc.nat() },
        { noNullPrototype: true },
      ),
      fc.record({ kind: fc.constant('delete' as const), id }, { noNullPrototype: true }),
    );
    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), (actions) => {
        const map = new IdMap<number>();
        const model = new Map<string, number>();
        for (const a of actions) {
          if (a.kind === 'set') {
            map.set(a.id, a.value);
            model.set(formatId(a.id), a.value);
          } else {
            assert.equal(map.delete(a.id), model.delete(formatId(a.id)));
          }
          assert.equal(map.size, model.size);
          assert.equal(map.get(a.id), model.get(formatId(a.id)));
        }
        const expected = [...model.keys()].sort((x, y) => {
          const [cx, rx] = x.split('@') as [string, string];
          const [cy, ry] = y.split('@') as [string, string];
          return Number(cx) - Number(cy) || codeUnitOrder(rx, ry);
        });
        assert.deepEqual(map.ids().map(formatId), expected);
      }),
      { numRuns: 500 },
    );
  });
});
