// What a replica holds depends only on which operations reached it (DESIGN.md "Order of delivery, duplicates, and
// conflicts"): not on their order, not on duplicates. And an operation whose dependency never arrives stays
// waiting, counts in `pending`, and changes nothing else (the day-2 test plan).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import type { Op } from '../src/protocol.ts';
import { Rga } from '../src/rga.ts';
import { wire } from './harness/rga-subject.ts';

const NAMES = ['m', 'Z', 'b'] as const;

type Step =
  | {
      readonly kind: 'edit';
      readonly by: number;
      readonly at: number;
      readonly deleteCount: number;
      readonly text: string;
    }
  | { readonly kind: 'sync'; readonly by: number };

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record(
      {
        kind: fc.constant('edit' as const),
        by: fc.nat({ max: NAMES.length - 1 }),
        at: fc.nat(),
        deleteCount: fc.nat({ max: 3 }),
        text: fc.string({ unit: fc.constantFrom('a', 'b', '😀'), maxLength: 3 }),
      },
      { noNullPrototype: true },
    ),
  },
  {
    weight: 1,
    arbitrary: fc.record(
      { kind: fc.constant('sync' as const), by: fc.nat({ max: NAMES.length - 1 }) },
      { noNullPrototype: true },
    ),
  },
);

/**
 * Every operation of an editing session in which replicas edit concurrently and now and then catch up on
 * everything made so far, in the order they were made (a causal order).
 */
function session(steps: readonly Step[]): Op[] {
  const replicas = NAMES.map((name) => new Rga(name));
  const applied = NAMES.map(() => 0);
  const ops: Op[] = [];
  for (const s of steps) {
    const r = replicas[s.by] as Rga;
    if (s.kind === 'sync') {
      for (const op of ops.slice(applied[s.by])) r.apply(op);
    } else {
      const index = s.at % (r.length + 1);
      ops.push(...r.edit(index, Math.min(s.deleteCount, r.length - index), s.text));
    }
    applied[s.by] = s.kind === 'sync' ? ops.length : (applied[s.by] as number);
  }
  return ops;
}

const sessions = fc.array(step, { maxLength: 30, size: 'max' }).map(session);

/** The operations at `indexes` (with repeats: duplicates), in that order, applied to a new replica through the codec. */
function receive(ops: readonly Op[], indexes: readonly number[]): Rga {
  const rga = new Rga('r');
  for (const i of indexes) rga.apply(wire(ops[i]));
  return rga;
}

/** A pick of operations: each index from 0 to n - 1 in or out, then repeats of some, all in a generated order. */
const arrivals = (n: number) =>
  fc
    .tuple(
      fc.subarray(Array.from({ length: n }, (_, i) => i)),
      fc.array(fc.nat(), { maxLength: 10 }),
      fc.array(fc.nat(), { maxLength: 200, size: 'max' }),
    )
    .map(([chosen, repeats, picks]) => {
      const all = [
        ...chosen,
        ...(chosen.length === 0 ? [] : repeats.map((r) => chosen[r % chosen.length] as number)),
      ];
      const order: number[] = [];
      for (let i = 0; all.length > 0; i++)
        order.push(...all.splice((picks[i] ?? 0) % all.length, 1));
      return { chosen, order };
    });

describe('a replica', () => {
  test('holds the same state for the same operations, in any order, with any duplicates', () => {
    fc.assert(
      fc.property(
        sessions.chain((ops) =>
          fc.tuple(fc.constant(ops), arrivals(ops.length), fc.array(fc.nat(), { maxLength: 200 })),
        ),
        ([ops, { chosen, order }, picks]) => {
          const first = receive(ops, order);
          // The same operations once each, in another order.
          const left = [...chosen];
          const other: number[] = [];
          for (let i = 0; left.length > 0; i++)
            other.push(...left.splice((picks[i] ?? 0) % left.length, 1));
          const second = receive(ops, other);
          assert.equal(first.state(), second.state());
          assert.equal(first.pending, second.pending);
          assert.equal(first.text(), second.text());
          // And in the order they were made, the order the server's log has.
          const causal = receive(
            ops,
            [...chosen].sort((a, b) => a - b),
          );
          assert.equal(causal.state(), first.state());
          assert.equal(causal.pending, first.pending);
        },
      ),
      { numRuns: 500 },
    );
  });

  test('counts as pending exactly the operations whose dependencies did not arrive', () => {
    fc.assert(
      fc.property(
        sessions.chain((ops) => fc.tuple(fc.constant(ops), arrivals(ops.length))),
        ([ops, { chosen, order }]) => {
          const rga = receive(ops, order);
          // The model: a run is placed if its origin is HEAD or an element of a placed run; every other run
          // received waits. A delete waits if it names an id no received insert carries.
          // Distinct by content: two replicas deleting the same text at once make the same delete, and a
          // replica can't tell them apart (the first counterexample of this test was such a pair).
          const received = [
            ...new Map(chosen.map((i) => [JSON.stringify(ops[i]), ops[i] as Op])).values(),
          ];
          const inserts = received.filter((op) => op.type === 'insert');
          const carried = new Set(
            inserts.flatMap((op) =>
              Array.from(op.text, (_, k) => `${op.id.counter + k}@${op.id.replica}`),
            ),
          );
          const placed = new Set<string>();
          for (let grew = true; grew;) {
            grew = false;
            for (const op of inserts) {
              const first = `${op.id.counter}@${op.id.replica}`;
              const origin =
                op.origin === null ? null : `${op.origin.counter}@${op.origin.replica}`;
              if (placed.has(first) || (origin !== null && !placed.has(origin))) continue;
              for (let k = 0; k < Array.from(op.text).length; k++)
                placed.add(`${op.id.counter + k}@${op.id.replica}`);
              grew = true;
            }
          }
          const waitingInserts = inserts.filter(
            (op) => !placed.has(`${op.id.counter}@${op.id.replica}`),
          ).length;
          const waitingDeletes = received.filter(
            (op) =>
              op.type === 'delete' &&
              op.spans.some((s) =>
                Array.from({ length: s.length }, (_, k) => `${s.counter + k}@${s.replica}`).some(
                  (id) => !carried.has(id),
                ),
              ),
          ).length;
          assert.equal(rga.pending, waitingInserts + waitingDeletes);
          // Visible are exactly the placed elements that no received delete names.
          const deleted = new Set(
            received.flatMap((op) =>
              op.type === 'delete'
                ? op.spans.flatMap((s) =>
                    Array.from({ length: s.length }, (_, k) => `${s.counter + k}@${s.replica}`),
                  )
                : [],
            ),
          );
          assert.equal(rga.length, [...placed].filter((id) => !deleted.has(id)).length);
        },
      ),
      { numRuns: 500 },
    );
  });

  test('missing some operations, then given them, ends where a replica given everything does', () => {
    fc.assert(
      fc.property(
        sessions.chain((ops) =>
          fc.tuple(fc.constant(ops), arrivals(ops.length), fc.array(fc.nat(), { maxLength: 200 })),
        ),
        ([ops, { chosen, order }, picks]) => {
          const rga = receive(ops, order);
          const rest = ops.map((_, i) => i).filter((i) => !chosen.includes(i));
          for (let i = 0; rest.length > 0; i++) {
            rga.apply(wire(ops[rest.splice((picks[i] ?? 0) % rest.length, 1)[0] as number]));
          }
          const everything = receive(
            ops,
            ops.map((_, i) => i),
          );
          assert.equal(rga.pending, 0);
          assert.equal(rga.state(), everything.state());
        },
      ),
      { numRuns: 500 },
    );
  });
});
