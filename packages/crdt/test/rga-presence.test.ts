// Positions as ids, for presence (DESIGN.md "Positions and ids"): a cursor is kept as "just after element X" and
// turned back into an index with indexAfter, so it stays next to the same text while others edit.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import type { Id } from '../src/protocol.ts';
import { Rga } from '../src/rga.ts';

interface Edit {
  readonly by: 'a' | 'b';
  readonly at: number;
  readonly deleteCount: number;
  readonly text: string;
}

/** Up to `maxLength` edits: 'max' because fast-check's default size stops arrays at about 10 items. */
const edits = (maxLength: number) =>
  fc.array(
    fc.record(
      {
        by: fc.constantFrom('a' as const, 'b' as const),
        at: fc.nat(),
        deleteCount: fc.nat({ max: 4 }),
        text: fc.string({ unit: fc.constantFrom('a', 'b', '😀'), maxLength: 4 }),
      },
      { noNullPrototype: true },
    ),
    { maxLength, size: 'max' },
  );

/** Two replicas that have exchanged every edit: the same document, with ids from both and tombstones. */
function shared(list: readonly Edit[]): { a: Rga; b: Rga } {
  const a = new Rga('a');
  const b = new Rga('b');
  for (const e of list) {
    const [from, to] = e.by === 'a' ? [a, b] : [b, a];
    const index = e.at % (from.length + 1);
    for (const op of from.edit(index, Math.min(e.deleteCount, from.length - index), e.text))
      to.apply(op);
  }
  assert.equal(a.state(), b.state());
  return { a, b };
}

describe('idBefore and indexAfter', () => {
  test('turn every index into an id and back', () => {
    fc.assert(
      fc.property(edits(25), (list) => {
        const { a } = shared(list);
        for (let i = 0; i <= a.length; i++) {
          const id = a.idBefore(i);
          assert.equal(a.indexAfter(id), i);
          if (i > 0) assert.deepEqual(a.idBefore(a.indexAfter(id) as number), id);
        }
      }),
      { numRuns: 500 },
    );
  });

  test('keep a cursor next to its text while another replica edits', () => {
    // The client's rule for a caret, valid while the element before it is visible: an insert at an index before
    // the cursor shifts it right, a delete entirely before it shifts it left, anything after it changes nothing.
    // Once a delete takes the element itself, the cursor's anchor is a tombstone and the check stops.
    fc.assert(
      fc.property(edits(15), fc.nat(), edits(15), (base, at, later) => {
        const { a, b } = shared(base);
        let cursor = at % (a.length + 1);
        const anchor = a.idBefore(cursor);
        for (const e of later) {
          const index = e.at % (b.length + 1);
          for (const op of b.edit(index, Math.min(e.deleteCount, b.length - index), e.text)) {
            for (const change of a.apply(op)) {
              if (change.type === 'insert') {
                if (change.index < cursor) cursor += Array.from(change.text).length;
              } else if (change.index + change.count < cursor) {
                cursor -= change.count;
              } else if (change.index < cursor) {
                return; // the anchor itself was deleted
              }
            }
            assert.equal(a.indexAfter(anchor), cursor);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  test('move a cursor after deleted text to where the text was', () => {
    const rga = new Rga('a');
    rga.edit(0, 0, 'abcd');
    const afterC = rga.idBefore(3) as Id;
    assert.deepEqual(afterC, { replica: 'a', counter: 3 });
    rga.edit(2, 1, ''); // delete "c"
    assert.equal(rga.indexAfter(afterC), 2);
    rga.edit(0, 2, ''); // delete "ab"
    assert.equal(rga.indexAfter(afterC), 0);
    rga.edit(0, 0, 'XY'); // typed at the start: after HEAD, before the tombstones
    assert.equal(rga.text(), 'XYd');
    assert.equal(rga.indexAfter(afterC), 2);
  });

  test('know nothing of elements not placed here', () => {
    const rga = new Rga('z');
    rga.apply({
      type: 'insert',
      id: { replica: 'a', counter: 5 },
      origin: { replica: 'q', counter: 1 },
      text: 'x',
    });
    assert.equal(rga.indexAfter({ replica: 'a', counter: 5 }), undefined, 'waiting');
    assert.equal(rga.indexAfter({ replica: 'a', counter: 6 }), undefined, 'unknown');
    assert.equal(rga.indexAfter(null), 0);
  });

  test('idBefore refuses indexes outside the text and returns a copy', () => {
    const rga = new Rga('a');
    rga.edit(0, 0, 'ab');
    for (const index of [-1, 3, 0.5, Number.NaN]) {
      assert.throws(() => rga.idBefore(index), RangeError, String(index));
    }
    assert.equal(rga.idBefore(0), null);
    const id = rga.idBefore(2) as { counter: number };
    id.counter = 1;
    assert.deepEqual(rga.idBefore(2), { replica: 'a', counter: 2 });
    assert.equal(rga.indexAfter({ replica: 'a', counter: 2 }), 2);
  });
});
