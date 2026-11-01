// Rga.collect (day 4, DESIGN.md "Tombstones"): removing leaf tombstones that no operation still to arrive can name
// changes nothing anyone can see. A "server" replica applies the log as it grows (each operation stamped with its
// place in the log) and now and then collects every tombstone last deleted at or before the point all three clients
// have applied: from then on a client can't name those (it has seen them deleted), and anything already in the log
// that names one keeps it (a child or a later delete). A reference replica that never collects must report the same
// changes for every operation, and end with the same text, as must every client.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import type { Op } from '../src/protocol.ts';
import { CollectedError, Rga, type Change } from '../src/rga.ts';

type Step =
  | { kind: 'edit'; by: number; at: number; del: number; text: string }
  | { kind: 'sync'; by: number }
  | { kind: 'collect' };

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record(
      {
        kind: fc.constant('edit' as const),
        by: fc.nat({ max: 2 }),
        at: fc.nat(),
        del: fc.oneof(fc.constant(0), fc.nat({ max: 3 }), fc.nat({ max: 20 })),
        text: fc.string({ unit: fc.constantFrom('a', 'b', '😀'), maxLength: 4 }),
      },
      { noNullPrototype: true },
    ),
  },
  {
    weight: 2,
    arbitrary: fc.record(
      { kind: fc.constant('sync' as const), by: fc.nat({ max: 2 }) },
      { noNullPrototype: true },
    ),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'collect' as const }) },
);

interface Outcome {
  collected: number;
  server: Rga;
}

/** Runs the steps; checks the server against the reference at every operation; returns what was collected. */
function run(steps: readonly Step[], blockSize?: number): Outcome {
  const options = blockSize === undefined ? {} : { blockSize };
  const clients = ['p', 'Q', 'r'].map((name) => new Rga(name, options));
  const applied = clients.map(() => 0);
  const server = new Rga('server', options);
  const reference = new Rga('server', options);
  const log: Op[] = [];
  let collected = 0;
  const append = (op: Op) => {
    log.push(op);
    const stamp = log.length;
    const got: Change[] = server.apply(op, stamp);
    const want: Change[] = reference.apply(op, stamp);
    assert.deepEqual(got, want, `entry ${stamp}: the changes differ`);
  };
  for (const s of steps) {
    if (s.kind === 'collect') {
      collected += server.collect(Math.min(...applied));
      assert.equal(server.text(), reference.text());
      continue;
    }
    const c = clients[s.by] as Rga;
    if (s.kind === 'sync') {
      for (const op of log.slice(applied[s.by])) c.apply(op);
      applied[s.by] = log.length;
    } else {
      const at = s.at % (c.length + 1);
      for (const op of c.edit(at, Math.min(s.del, c.length - at), s.text)) {
        assert.equal(server.namesCollected(op), false, 'a client named a collected id');
        append(op);
      }
      // A client's own operations are in the log; it has applied them, but not the ones before them it missed.
    }
  }
  for (const [i, c] of clients.entries()) {
    for (const op of log.slice(applied[i])) c.apply(op);
    assert.equal(c.text(), server.text());
  }
  assert.equal(server.text(), reference.text());
  for (let i = 0; i <= server.length; i++) {
    assert.deepEqual(server.idBefore(i), reference.idBefore(i));
  }
  return { collected, server };
}

const sessions = fc.array(step, { minLength: 1, maxLength: 80, size: 'max' });

describe('Rga.collect', () => {
  test('changes no reported change, text or position, whenever every client has seen the deletes', () => {
    let total = 0;
    let runs = 0;
    fc.assert(
      fc.property(sessions, (steps) => {
        total += run(steps).collected;
        runs++;
      }),
      { numRuns: 400 },
    );
    // So a collect that never collects can't pass: the sessions must actually take tombstones out.
    assert.ok(total > runs, `${total} elements collected in ${runs} sessions`);
  });

  test('the same with blocks of 1 and 2 elements (empty blocks dropped)', () => {
    for (const blockSize of [1, 2]) {
      fc.assert(
        fc.property(sessions, (steps) => {
          run(steps, blockSize);
        }),
        { numRuns: 200 },
      );
    }
  });

  test("a snapshot and its collected ids rebuild the server's state exactly", () => {
    fc.assert(
      fc.property(sessions, (steps) => {
        const { server } = run(steps);
        // A last collection through write: what it's given is what the replica then holds.
        let written: { ops: Op[]; collected: unknown[] } | null = null;
        server.collect(Number.MAX_SAFE_INTEGER, (after) => {
          written = after;
        });
        assert.deepEqual(written, { ops: server.snapshot(), collected: server.collectedSpans() });
        const rebuilt = new Rga('server');
        rebuilt.markCollected(server.collectedSpans());
        for (const op of server.snapshot()) rebuilt.apply(op);
        assert.equal(rebuilt.state(), server.state());
      }),
      { numRuns: 300 },
    );
  });

  test('with write: given the snapshot of the state after, and a write that throws changes nothing', () => {
    const rga = new Rga('s');
    rga.edit(0, 0, 'abc');
    rga.apply({ type: 'delete', spans: [{ replica: 's', counter: 2, length: 2 }] }, 4);
    const state = rga.state();
    assert.throws(
      () =>
        rga.collect(4, () => {
          throw new Error('the disk is full');
        }),
      /the disk is full/,
    );
    assert.equal(rga.state(), state, 'nothing changed');
    let written: { ops: Op[]; collected: unknown[] } | null = null;
    assert.equal(
      rga.collect(4, (after) => {
        written = after;
      }),
      2,
    );
    assert.deepEqual(written, { ops: rga.snapshot(), collected: rga.collectedSpans() });
  });

  test('takes a run from its end, then its origin once no run names it', () => {
    const rga = new Rga('s');
    const a = rga.edit(0, 0, 'abc'); // 1-3@s
    rga.edit(3, 0, 'XY'); // 4-5@s after c
    rga.apply({ type: 'delete', spans: [{ replica: 's', counter: 2, length: 4 }] }, 7); // b c X Y
    assert.equal(rga.text(), 'a');
    // c is not a leaf while XY's run names it; Y, X, then c, then b go.
    assert.equal(rga.collect(6), 0, 'nothing deleted at or before 6');
    assert.equal(rga.collect(7), 4);
    assert.match(rga.state(), /collected 2\+4@s$/);
    assert.deepEqual(rga.snapshot(), [{ ...(a[0] as Op & { type: 'insert' }), text: 'a' }]);
    assert.equal(rga.sizes().elements, 1);
  });

  test('takes an origin at a later collection once an earlier one took the run naming it (release review)', () => {
    // The run counts of the elements left must follow what each collection takes: a reload recounts them from the
    // snapshot, so a replica that didn't would collect less than its own reload (a mutant found no test noticing).
    const rga = new Rga('s');
    rga.edit(0, 0, 'ab'); // 1-2@s
    rga.edit(2, 0, 'XY'); // 3-4@s after b: b is not a leaf while XY's run names it
    rga.apply({ type: 'delete', spans: [{ replica: 's', counter: 3, length: 2 }] }, 2); // X Y
    rga.apply({ type: 'delete', spans: [{ replica: 's', counter: 2, length: 1 }] }, 5); // b, later
    assert.equal(rga.collect(3), 2, 'XY, not b: its delete is too recent');
    assert.equal(rga.collect(5), 1, 'b, now that no run names it');
    assert.equal(rga.text(), 'a');
    assert.match(rga.state(), /collected 2\+3@s$/);
  });

  test('keeps a tombstone a later delete named until that delete is old enough too', () => {
    const rga = new Rga('s');
    rga.edit(0, 0, 'ab');
    const del = { type: 'delete' as const, spans: [{ replica: 's', counter: 2, length: 1 }] };
    rga.apply(del, 3);
    rga.apply(del, 9); // a repeat, logged later
    assert.equal(rga.collect(8), 0);
    assert.equal(rga.collect(9), 1);
  });

  test('never takes a tombstone deleted without a stamp, or one a waiting run names', () => {
    const rga = new Rga('s');
    rga.edit(0, 0, 'ab');
    rga.edit(1, 1, ''); // a local delete: no stamp
    assert.equal(rga.collect(Number.MAX_SAFE_INTEGER), 0);
    const other = new Rga('s');
    other.apply({ type: 'insert', id: { replica: 's', counter: 1 }, origin: null, text: 'ab' });
    other.apply({
      type: 'insert',
      id: { replica: 't', counter: 9 },
      origin: { replica: 'z', counter: 3 },
      text: 'w',
    });
    other.apply({ type: 'delete', spans: [{ replica: 's', counter: 2, length: 1 }] }, 5);
    // A run waiting on 3@z doesn't name 2@s; 2@s goes. One naming 2@s as its origin would keep it:
    const keeps = new Rga('k');
    keeps.apply({ type: 'insert', id: { replica: 's', counter: 1 }, origin: null, text: 'ab' });
    keeps.apply({
      type: 'insert',
      id: { replica: 't', counter: 5 },
      origin: { replica: 's', counter: 2 },
      text: 'w',
    });
    keeps.apply({ type: 'delete', spans: [{ replica: 's', counter: 2, length: 1 }] }, 5);
    assert.equal(other.collect(5), 1);
    assert.equal(keeps.collect(5), 0);
  });

  test('refuses an insert naming a collected id, and skips collected ids in a delete', () => {
    const rga = new Rga('s');
    rga.edit(0, 0, 'abc');
    rga.apply({ type: 'delete', spans: [{ replica: 's', counter: 3, length: 1 }] }, 1);
    assert.equal(rga.collect(1), 1);
    const after: Op = {
      type: 'insert',
      id: { replica: 't', counter: 9 },
      origin: { replica: 's', counter: 3 },
      text: 'x',
    };
    const reuse: Op = {
      type: 'insert',
      id: { replica: 's', counter: 3 },
      origin: { replica: 's', counter: 2 },
      text: 'c',
    };
    const before = rga.state();
    for (const op of [after, reuse]) {
      assert.ok(rga.namesCollected(op));
      // ready() looks at dependencies only: the reuse's origin is placed. namesCollected is what catches it.
      if (op === after) assert.equal(rga.ready(op), false);
      assert.throws(() => rga.apply(op), CollectedError);
      assert.equal(rga.state(), before);
    }
    const again: Op = { type: 'delete', spans: [{ replica: 's', counter: 2, length: 2 }] };
    assert.ok(rga.namesCollected(again));
    assert.deepEqual(rga.apply(again), [{ type: 'delete', index: 1, count: 1 }]);
    assert.equal(rga.pending, 0, 'the collected id is not waited for');
  });

  test('markCollected refuses ids held, and moves the clock past its own', () => {
    const rga = new Rga('s');
    rga.edit(0, 0, 'a');
    assert.throws(() => {
      rga.markCollected([{ replica: 's', counter: 1, length: 1 }]);
    }, /held here/);
    rga.markCollected([{ replica: 's', counter: 5, length: 3 }]);
    assert.equal(rga.clock, 7);
    const [op] = rga.edit(1, 0, 'b') as [Op & { type: 'insert' }];
    assert.equal(op.id.counter, 8);
  });
});
