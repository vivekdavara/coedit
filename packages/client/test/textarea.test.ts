// Remote changes on the textarea's text and selection (src/textarea.ts).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import { Rga, type Change } from '@coedit/crdt';
import { applyChanges, replicaHue } from '../src/textarea.ts';
import { codePointToUtf16, utf16ToCodePoint } from '../src/edit.ts';

const ins = (index: number, text: string): Change => ({ type: 'insert', index, text });
const del = (index: number, count: number): Change => ({ type: 'delete', index, count });

describe('applyChanges', () => {
  test('an insert before the caret shifts it; at the caret or after it, it stays', () => {
    const state = { text: 'abcd', start: 2, end: 2 };
    assert.deepEqual(applyChanges(state, [ins(1, 'XY')]), { text: 'aXYbcd', start: 4, end: 4 });
    assert.deepEqual(applyChanges(state, [ins(2, 'XY')]), { text: 'abXYcd', start: 2, end: 2 });
    assert.deepEqual(applyChanges(state, [ins(3, 'XY')]), { text: 'abcXYd', start: 2, end: 2 });
  });

  test('a delete before the caret shifts it, around it pulls it to the start, after it leaves it', () => {
    const state = { text: 'abcdef', start: 3, end: 3 };
    assert.deepEqual(applyChanges(state, [del(0, 2)]), { text: 'cdef', start: 1, end: 1 });
    assert.deepEqual(applyChanges(state, [del(1, 1)]), { text: 'acdef', start: 2, end: 2 });
    assert.deepEqual(applyChanges(state, [del(1, 2)]), { text: 'adef', start: 1, end: 1 });
    assert.deepEqual(applyChanges(state, [del(2, 3)]), { text: 'abf', start: 2, end: 2 });
    assert.deepEqual(applyChanges(state, [del(3, 2)]), { text: 'abcf', start: 3, end: 3 });
  });

  test('a selection keeps its ends where the text they were next to went', () => {
    const state = { text: 'abcdef', start: 1, end: 4 };
    // Inside it: the end moves, the start doesn't.
    assert.deepEqual(applyChanges(state, [ins(2, 'XY')]), { text: 'abXYcdef', start: 1, end: 6 });
    // Over its end.
    assert.deepEqual(applyChanges(state, [del(3, 3)]), { text: 'abc', start: 1, end: 3 });
    // All of it.
    assert.deepEqual(applyChanges(state, [del(0, 6)]), { text: '', start: 0, end: 0 });
  });

  test('converts code points to UTF-16 against the text just before each change', () => {
    // '😀' is one code point and two UTF-16 units.
    const state = { text: '😀a😀', start: 5, end: 5 };
    const after = applyChanges(state, [ins(1, '😀'), del(0, 1), ins(3, 'z')]);
    assert.deepEqual(after, { text: '😀a😀z', start: 5, end: 5 });
    assert.deepEqual(applyChanges({ text: '😀😀', start: 4, end: 4 }, [del(0, 1)]), {
      text: '😀',
      start: 2,
      end: 2,
    });
  });

  test('on real changes, the text is the replica text and the caret stays next to the same element', () => {
    // A replica with random remote edits: the caret, kept as the id of the element before it, must end up where
    // applyChanges moved it, unless that element was deleted (then it sits where the deleted text began).
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom('a', 'b', '😀'), minLength: 1, maxLength: 12 }),
        fc.nat(),
        fc.array(
          fc.record({
            index: fc.nat(),
            count: fc.nat({ max: 4 }),
            text: fc.string({ unit: fc.constantFrom('x', '😀'), maxLength: 3 }),
          }),
          { maxLength: 8 },
        ),
        (initial, caretSeed, edits) => {
          const mine = new Rga('me');
          const theirs = new Rga('them');
          for (const op of theirs.edit(0, 0, initial)) mine.apply(op);
          const points = mine.length;
          const caret = caretSeed % (points + 1);
          let state = {
            text: mine.text(),
            start: codePointToUtf16(mine.text(), caret),
            end: codePointToUtf16(mine.text(), caret),
          };
          const before = mine.idBefore(caret);
          let deleted = false;
          for (const e of edits) {
            const index = e.index % (theirs.length + 1);
            const count = Math.min(e.count, theirs.length - index);
            for (const op of theirs.edit(index, count, e.text)) {
              const changes = mine.apply(op);
              state = applyChanges(state, changes);
              assert.equal(state.text, mine.text());
            }
            if (before !== null && mine.indexAfter(before) !== undefined) {
              // indexAfter of a tombstone is where it was.
              const visible = mine.idBefore(mine.indexAfter(before) as number);
              if (
                visible === null ||
                visible.counter !== before.counter ||
                visible.replica !== before.replica
              )
                deleted = true;
            }
          }
          const at = utf16ToCodePoint(state.text, state.start);
          assert.equal(state.start, state.end);
          if (!deleted) assert.equal(at, mine.indexAfter(before));
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

describe('replicaHue', () => {
  test('is the same for the same id, from 0 to 359, and spreads ids out', () => {
    assert.equal(replicaHue('abc'), replicaHue('abc'));
    const hues = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const hue = replicaHue(`replica-${i}`);
      assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360);
      hues.add(Math.floor(hue / 30));
    }
    assert.equal(hues.size, 12, 'every 30-degree band used');
  });
});
