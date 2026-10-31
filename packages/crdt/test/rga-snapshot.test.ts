// Rga.snapshot (day 4): the operations a server stores and sends instead of a long log. Applied to a new replica they
// rebuild the state exactly; applied to a replica that already holds some of the operations they merge, so a client
// that was behind gets everything without being told what it already had.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import { MAX_INSERT_LENGTH, MAX_SPANS, type Op } from '../src/protocol.ts';
import { Rga } from '../src/rga.ts';
import { wire } from './harness/rga-subject.ts';
import { sessions } from './harness/sessions.ts';

function replay(ops: readonly Op[], into = new Rga('r')): Rga {
  for (const op of ops) into.apply(wire(op));
  return into;
}

describe('Rga.snapshot', () => {
  test('rebuilds the same state in a new replica', () => {
    fc.assert(
      fc.property(sessions, (ops) => {
        const source = replay(ops);
        const rebuilt = replay(source.snapshot());
        assert.equal(rebuilt.state(), source.state());
        assert.equal(rebuilt.text(), source.text());
        assert.equal(rebuilt.pending, 0);
      }),
      { numRuns: 300 },
    );
  });

  test('merges into a replica holding any causal prefix of the log, and changes nothing more after it', () => {
    fc.assert(
      fc.property(
        sessions.chain((ops) => fc.tuple(fc.constant(ops), fc.nat({ max: ops.length }))),
        ([ops, k]) => {
          const source = replay(ops);
          const behind = replay(ops.slice(0, k));
          replay(source.snapshot(), behind);
          assert.equal(behind.state(), source.state());
          // The rest of the log, arriving after the snapshot (a client's catch-up overlaps it), changes nothing.
          replay(ops.slice(k), behind);
          assert.equal(behind.state(), source.state());
        },
      ),
      { numRuns: 300 },
    );
  });

  test('merges with operations the source never saw, as those operations would have', () => {
    // A client's unsent edits: the snapshot must not undo them, and the result is what applying everything gives.
    fc.assert(
      fc.property(
        sessions.chain((ops) => fc.tuple(fc.constant(ops), fc.nat({ max: ops.length }))),
        ([ops, k]) => {
          const source = replay(ops.slice(0, k));
          const client = replay(ops);
          replay(source.snapshot(), client);
          assert.equal(client.state(), replay(ops).state());
        },
      ),
      { numRuns: 300 },
    );
  });

  test('writes each run whole, in an order with every origin first', () => {
    const rga = new Rga('a');
    rga.edit(0, 0, 'hello');
    rga.edit(2, 0, 'XY'); // splits the run "hello" in the sequence: he XY llo
    rga.edit(0, 1, ''); // a tombstone
    const ops = rga.snapshot();
    assert.deepEqual(ops, [
      { type: 'insert', id: { replica: 'a', counter: 1 }, origin: null, text: 'hello' },
      {
        type: 'insert',
        id: { replica: 'a', counter: 6 },
        origin: { replica: 'a', counter: 2 },
        text: 'XY',
      },
      { type: 'delete', spans: [{ replica: 'a', counter: 1, length: 1 }] },
    ]);
    assert.equal(replay(ops).text(), 'eXYllo');
  });

  test('of an empty replica is empty, and a replica holding waiting operations has none', () => {
    assert.deepEqual(new Rga('a').snapshot(), []);
    const waiting = new Rga('b');
    waiting.apply({
      type: 'insert',
      id: { replica: 'c', counter: 5 },
      origin: { replica: 'c', counter: 4 },
      text: 'x',
    });
    assert.throws(() => waiting.snapshot(), /1 operations are waiting/);
  });

  test('keeps to the wire format limits: long tombstone lists become several deletes', () => {
    const rga = new Rga('a');
    // 2,500 one-character runs, every other one deleted: 1,250 tombstone spans that can't merge.
    for (let i = 0; i < 2500; i++) rga.edit(i, 0, String.fromCodePoint(97 + (i % 26)));
    for (let i = 0; i < 1250; i++) rga.edit(i, 1, ''); // deletes the 1st, 3rd, 5th, ... of the original
    const ops = rga.snapshot();
    const deletes = ops.filter((op) => op.type === 'delete');
    assert.equal(deletes.length, 2);
    for (const op of deletes) assert.ok(op.spans.length <= MAX_SPANS);
    for (const op of ops) if (op.type === 'insert') assert.ok(op.text.length <= MAX_INSERT_LENGTH);
    assert.equal(replay(ops).state(), rga.state());
  });

  test('returns copies: changing them changes nothing in the replica', () => {
    const rga = new Rga('a');
    rga.edit(0, 0, 'ab');
    const [op] = rga.snapshot() as [Op & { type: 'insert' }];
    (op.id as { counter: number }).counter = 99;
    assert.deepEqual(rga.snapshot()[0], {
      type: 'insert',
      id: { replica: 'a', counter: 1 },
      origin: null,
      text: 'ab',
    });
  });
});
