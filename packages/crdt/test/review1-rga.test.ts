// Review 1 of day 2 (at 0cbad60): its findings, each of which failed before its fix.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import fc from 'fast-check';
import type { DeleteOp, InsertOp } from '../src/protocol.ts';
import { Rga } from '../src/rga.ts';

const del = (...spans: [number, string, number][]): DeleteOp => ({
  type: 'delete',
  spans: spans.map(([counter, replica, length]) => ({ replica, counter, length })),
});

// Finding 1 (already fixed in 63e271a when the review reported it): a delete was counted as pending only if it
// named a missing id no earlier delete had named, so the count depended on the order of arrival.
test('three deletes waiting on ids that never arrive count three in either order', () => {
  const d1 = del([5, 'a', 2]);
  const d2 = del([5, 'a', 1]);
  const d3 = del([6, 'a', 1]);
  const x = new Rga('x');
  for (const op of [d1, d2, d3]) x.apply(op);
  const y = new Rga('y');
  for (const op of [d2, d3, d1]) y.apply(op);
  assert.equal(x.state(), y.state());
  assert.equal(x.pending, 3);
  assert.equal(y.pending, 3);
});

test('two concurrent deletes of the same text, the insert not yet here, count the same in either order', () => {
  const a = new Rga('a');
  const b = new Rga('b');
  const c = new Rga('c');
  for (const op of a.edit(0, 0, 'ab')) {
    b.apply(op);
    c.apply(op);
  }
  const [fromB] = b.edit(0, 2, '') as [DeleteOp];
  const [fromC] = c.edit(0, 1, '') as [DeleteOp];
  const x = new Rga('x');
  x.apply(fromB);
  x.apply(fromC);
  const y = new Rga('y');
  y.apply(fromC);
  y.apply(fromB);
  assert.equal(x.state(), y.state());
  assert.equal(x.pending, 2);
  assert.equal(y.pending, 2);
});

// Finding 2: releasing the runs waiting on one element spread the whole list into push(), which overflows the
// stack at about 110,000 runs, after the releasing insert was placed and the runs were taken out of the waiting
// map: they were lost (known, so a resend was a duplicate; never placed; not pending). state() spread the same
// list. With a 100 KB stack the old code overflowed at 20,000 (and not at 5,000), so the test runs there.
test('an element releasing 20,000 waiting runs places them all, even on a small stack', async () => {
  const script = fileURLToPath(new URL('./harness/fanout.ts', import.meta.url));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--stack-size=100', '--disable-warning=ExperimentalWarning', script, '20000'],
    { timeout: 60_000 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    waited: 20_000,
    listed: 20_000,
    threw: null,
    changes: 20_001,
    length: 20_001,
    pending: 0,
  });
});

// Finding 3: edit() returned an insert whose origin was the origin element's own id object, so a caller changing
// the returned operation renamed an element inside the replica (idBefore and state() then showed an id nobody
// made, while the id map still filed it under the old one).
test("changing an edit's returned origin changes nothing in the replica", () => {
  const rga = new Rga('a');
  rga.edit(0, 0, 'ab');
  const [op] = rga.edit(2, 0, 'c') as [InsertOp];
  const state = rga.state();
  const origin = op.origin as { replica: string; counter: number };
  origin.replica = 'zz';
  origin.counter = 1;
  assert.equal(rga.state(), state);
  assert.deepEqual(rga.idBefore(2), { replica: 'a', counter: 2 });
});

test('changing anything in any operation an edit returned changes nothing in the replica', () => {
  // Every object reachable from every returned operation, changed in every field it has.
  const scramble = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(record)) {
      if (typeof v === 'number') record[k] = v + 1_000;
      else if (typeof v === 'string') record[k] = k === 'type' ? v : `${v}zz`;
      else scramble(v);
    }
  };
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.nat(), fc.nat({ max: 3 }), fc.string({ maxLength: 3 })), {
        maxLength: 15,
      }),
      (edits) => {
        const scrambled = new Rga('a');
        const clean = new Rga('a');
        for (const [at, deleteCount, text] of edits) {
          const index = at % (clean.length + 1);
          const count = Math.min(deleteCount, clean.length - index);
          clean.edit(index, count, text);
          for (const op of scrambled.edit(index, count, text)) scramble(op);
          assert.equal(scrambled.state(), clean.state());
        }
      },
    ),
    { numRuns: 300 },
  );
});

// From the review's notes on the spec: the clock moved for every span of every delete, so one delete naming
// 2^53 - 1 of any replica stopped this replica's inserts for good. Only spans under this replica's own id need to
// move it (so its next ids aren't ones deleted ahead); and every such span must, not only the first (a mutant
// that skipped later spans survived the day's tests).
test("a delete moves the clock only for this replica's own ids, all of its spans", () => {
  const rga = new Rga('a', { clock: 3 });
  rga.apply(
    del([9, 'b', 2], [4, 'a', 1], [Number.MAX_SAFE_INTEGER, 'c', 1], [9, 'a', 3], [7, 'b', 1]),
  );
  assert.equal(rga.clock, 11);
  assert.equal(rga.pending, 1);
  // The next ids are 12 and 13: not deleted ahead, so the text shows.
  const [op] = rga.edit(0, 0, 'xy') as [InsertOp];
  assert.deepEqual(op.id, { replica: 'a', counter: 12 });
  assert.equal(rga.text(), 'xy');
});

// Two mutants survived the tests at 0cbad60 that the review ran (rga-pending.test.ts, written meanwhile, catches both, but only
// through a generated case): `length` counting an insert's elements deleted ahead, and state() listing the runs
// waiting on one origin in arrival order rather than id order.
test('length counts only the visible part of an insert whose elements were deleted ahead', () => {
  const rga = new Rga('r');
  rga.apply(del([2, 'a', 2]));
  rga.apply({ type: 'insert', id: { replica: 'a', counter: 1 }, origin: null, text: 'abcd' });
  assert.equal(rga.text(), 'ad');
  assert.equal(rga.length, 2);
  assert.deepEqual(rga.edit(2, 0, 'e'), [
    {
      type: 'insert',
      id: { replica: 'r', counter: 5 },
      origin: { replica: 'a', counter: 4 },
      text: 'e',
    },
  ]);
  assert.equal(rga.text(), 'ade');
});

test('state() lists runs waiting on one origin in id order, whatever order they arrived in', () => {
  const runs = ['x', 'y', 'z'].map((replica, i) => ({
    type: 'insert' as const,
    id: { replica, counter: 5 - i },
    origin: { replica: 'q', counter: 1 },
    text: replica,
  }));
  const forwards = new Rga('r');
  for (const op of runs) forwards.apply(op);
  const backwards = new Rga('r');
  for (const op of [...runs].reverse()) backwards.apply(op);
  assert.equal(forwards.state(), backwards.state());
  assert.match(forwards.state(), /waiting 3@z<1@q"z", 4@y<1@q"y", 5@x<1@q"x" \|/);
});
