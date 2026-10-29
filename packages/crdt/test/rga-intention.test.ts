// Intention preservation for inserts (DESIGN.md "Insert"): text typed at a spot appears there, and two people
// typing at the same spot at the same time get their runs one after the other, never interleaved. What RGA does
// not prevent, text typed backwards at one spot, is pinned here so it's documented, not discovered.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import type { Op } from '../src/protocol.ts';
import { Rga } from '../src/rga.ts';
import { REPLICA_NAMES } from './harness/network.ts';
import { wire } from './harness/rga-subject.ts';

/** Delivers `ops` to `rga` in the order `picks` gives (each pick chooses among those left), through the codec. */
function deliverShuffled(rga: Rga, ops: readonly Op[], picks: readonly number[]): void {
  const left = [...ops];
  for (let i = 0; left.length > 0; i++) {
    const [op] = left.splice((picks[i] ?? 0) % left.length, 1) as [Op];
    rga.apply(wire(op));
  }
  assert.equal(rga.pending, 0);
}

describe('concurrent typing at one spot', () => {
  test('keeps each typist run whole, larger replica first, between the text before and after the spot', () => {
    const typed = fc.string({
      unit: fc.constantFrom('a', 'b', '😀', '́'),
      minLength: 1,
      maxLength: 6,
    });
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom('x', 'y'), maxLength: 8 }),
        fc.nat(),
        fc.array(fc.tuple(typed, fc.boolean()), { minLength: 2, maxLength: 4 }),
        fc.array(fc.nat(), { maxLength: 100, size: 'max' }),
        fc.nat({ max: 3 }),
        (baseText, at, typists, picks, deletes) => {
          // The base, typed by one replica and given to the others, with a few deletes so tombstones sit around.
          const names = REPLICA_NAMES.slice(0, typists.length);
          const replicas = names.map((name) => new Rga(name));
          const [first] = replicas as [Rga];
          const baseOps = first.edit(0, 0, baseText);
          for (let i = 0; i < deletes && first.length > 0; i++) {
            baseOps.push(...first.edit((at + i) % first.length, 1, ''));
          }
          for (const r of replicas.slice(1)) for (const op of baseOps) r.apply(op);
          const base = Array.from(first.text());
          const spot = at % (base.length + 1);

          // Each typist types forwards, one keystroke at a time, or pastes the whole run at once.
          const sent = replicas.map((r, i) => {
            const [text, oneByOne] = typists[i] as [string, boolean];
            if (!oneByOne) return r.edit(spot, 0, text);
            return Array.from(text).flatMap((char, k) => r.edit(spot + k, 0, char));
          });
          replicas.forEach((r, i) => {
            deliverShuffled(r, sent.filter((_, j) => j !== i).flat(), picks);
          });

          // Same clocks after the shared base, so every run's first id has the same counter: the replica decides.
          const order = names
            .map((name, i) => [name, (typists[i] as [string, boolean])[0]] as const)
            .sort(([x], [y]) => (x < y ? 1 : -1))
            .map(([, text]) => text);
          const expected = [...base.slice(0, spot), ...order, ...base.slice(spot)].join('');
          for (const r of replicas) assert.equal(r.text(), expected);
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

describe('typing backwards', () => {
  // Each keystroke inserted before the last (as when pressing Home before every key): every character's origin
  // is the same element, so two such runs typed concurrently are siblings sorted by id and interleave.
  test('interleaves two concurrent runs, as DESIGN.md says', () => {
    const x = new Rga('x');
    const y = new Rga('y');
    const fromX = [...x.edit(0, 0, '2'), ...x.edit(0, 0, '1')]; // "12": 2@x is "1", 1@x is "2"
    const fromY = [...y.edit(0, 0, 'b'), ...y.edit(0, 0, 'a')]; // "ab": 2@y is "a", 1@y is "b"
    assert.equal(x.text(), '12');
    assert.equal(y.text(), 'ab');
    for (const op of fromY) x.apply(op);
    for (const op of fromX) y.apply(op);
    // The children of HEAD, largest id first: 2@y "a", 2@x "1", 1@y "b", 1@x "2".
    assert.equal(x.text(), 'a1b2');
    assert.equal(y.text(), 'a1b2');
  });

  test('the same runs typed forwards stay whole', () => {
    const x = new Rga('x');
    const y = new Rga('y');
    const fromX = [...x.edit(0, 0, '1'), ...x.edit(1, 0, '2')];
    const fromY = [...y.edit(0, 0, 'a'), ...y.edit(1, 0, 'b')];
    for (const op of fromY) x.apply(op);
    for (const op of fromX) y.apply(op);
    assert.equal(x.text(), 'ab12');
    assert.equal(y.text(), 'ab12');
  });

  test('one person typing backwards alone still gets exactly what they typed', () => {
    const x = new Rga('x');
    const y = new Rga('y');
    const ops = ['d', 'c', 'b', 'a'].flatMap((char) => x.edit(0, 0, char));
    assert.equal(x.text(), 'abcd');
    deliverShuffled(y, ops, [3, 1, 2, 0]);
    assert.equal(y.text(), 'abcd');
  });
});
