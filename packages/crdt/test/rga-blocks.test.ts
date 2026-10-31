// The blocks under the sequence (day 4) change how positions are found, never what they are. The same editing
// sessions run on replicas with tiny blocks (1 to 3 elements, so they split all the time) and on replicas whose one
// block never splits (the single array that came before) must agree on everything: the operations each local edit
// makes, the changes each remote operation reports, the text, the state, and every position for presence.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import type { Op } from '../src/protocol.ts';
import { Rga, type Change } from '../src/rga.ts';

const NAMES = ['p', 'Q', 'r'] as const;

type Step =
  | { kind: 'edit'; by: number; at: number; del: number; text: string }
  | { kind: 'sync'; by: number };

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record(
      {
        kind: fc.constant('edit' as const),
        by: fc.nat({ max: 2 }),
        at: fc.nat(),
        del: fc.oneof(fc.constant(0), fc.nat({ max: 3 }), fc.nat({ max: 40 })),
        text: fc.oneof(
          fc.string({ unit: fc.constantFrom('a', 'b', '😀'), maxLength: 3 }),
          fc.string({ unit: fc.constantFrom('x', 'y'), maxLength: 30 }),
        ),
      },
      { noNullPrototype: true },
    ),
  },
  {
    weight: 1,
    arbitrary: fc.record(
      { kind: fc.constant('sync' as const), by: fc.nat({ max: 2 }) },
      { noNullPrototype: true },
    ),
  },
);

/** Runs the steps on three replicas with `blockSize`; returns everything observable. */
function run(steps: readonly Step[], blockSize: number) {
  const replicas = NAMES.map((name) => new Rga(name, { blockSize }));
  const applied = NAMES.map(() => 0);
  const log: Op[] = [];
  const seen: { ops: Op[][]; changes: Change[][] } = { ops: [], changes: [] };
  for (const s of steps) {
    const r = replicas[s.by] as Rga;
    if (s.kind === 'sync') {
      for (const op of log.slice(applied[s.by])) seen.changes.push(r.apply(op));
      applied[s.by] = log.length;
    } else {
      const at = s.at % (r.length + 1);
      const ops = r.edit(at, Math.min(s.del, r.length - at), s.text);
      seen.ops.push(ops);
      log.push(...ops);
    }
  }
  const views = replicas.map((r) => {
    const before: unknown[] = [];
    for (let i = 0; i <= r.length; i++) before.push(r.idBefore(i));
    const after: unknown[] = [];
    for (const op of log) {
      if (op.type !== 'insert') continue;
      after.push(r.indexAfter(op.id));
      after.push(r.indexAfter({ replica: op.id.replica, counter: op.id.counter + 1 }));
    }
    return {
      text: r.text(),
      state: r.state(),
      sizes: r.sizes(),
      before,
      after,
      snapshot: r.snapshot(),
    };
  });
  return { seen, views };
}

const sessions = fc.array(step, { minLength: 1, maxLength: 60, size: 'max' });

describe('blocks', () => {
  for (const blockSize of [1, 2, 3]) {
    test(`of ${blockSize} element${blockSize === 1 ? '' : 's'} give exactly what one unsplit block gives`, () => {
      fc.assert(
        fc.property(sessions, (steps) => {
          assert.deepEqual(run(steps, blockSize), run(steps, Number.MAX_SAFE_INTEGER));
        }),
        { numRuns: 300 },
      );
    });
  }

  test('split: a long document in blocks of 4 holds every element once, in order', () => {
    const rga = new Rga('a', { blockSize: 4 });
    const one = new Rga('a', { blockSize: Number.MAX_SAFE_INTEGER });
    let text = '';
    for (let i = 0; i < 500; i++) {
      const at = (i * 7919) % (text.length + 1);
      const c = String.fromCodePoint(97 + (i % 26));
      rga.edit(at, 0, c);
      one.edit(at, 0, c);
      text = text.slice(0, at) + c + text.slice(at);
      if (i % 5 === 4) {
        const del = (i * 31) % text.length;
        rga.edit(del, 1, '');
        one.edit(del, 1, '');
        text = text.slice(0, del) + text.slice(del + 1);
      }
    }
    assert.equal(rga.text(), text);
    assert.equal(rga.state(), one.state());
    // A paste longer than many blocks at once.
    rga.edit(10, 0, 'z'.repeat(1000));
    one.edit(10, 0, 'z'.repeat(1000));
    assert.equal(rga.state(), one.state());
    assert.equal(rga.indexAfter(rga.idBefore(600)), 600);
  });

  test('a block size must be a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => new Rga('a', { blockSize: bad }), /block size/);
    }
  });
});
