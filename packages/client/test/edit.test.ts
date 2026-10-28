import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import { applyEdit, codePointToUtf16, diffText, utf16ToCodePoint, type Edit } from '../src/edit.ts';

/** Small alphabets, so repeated characters (the ambiguous cases) are common; the emoji is two UTF-16 units. */
const unit = fc.constantFrom('a', 'b', '😀', '\n');
const text = fc.string({ unit, maxLength: 12 });
const points = (s: string) => Array.from(s).length;

/** A random single edit of a random text, with the caret where the browser leaves it: after the inserted text. */
const typed = text.chain((before) =>
  fc
    .tuple(fc.nat({ max: points(before) }), fc.nat({ max: 4 }), fc.string({ unit, maxLength: 4 }))
    .map(([index, wantDelete, insert]) => {
      const edit: Edit = {
        index,
        deleteCount: Math.min(wantDelete, points(before) - index),
        text: insert,
      };
      const after = applyEdit(before, edit);
      const caret = codePointToUtf16(after, index + points(insert));
      return { before, after, edit, caret };
    }),
);

describe('diffText', () => {
  test('null when nothing changed', () => {
    assert.equal(diffText('abc', 'abc'), null);
    assert.equal(diffText('', '', 0), null);
  });

  test('typing into a run of the same letter goes where the caret is', () => {
    // "aa" -> "aaa" with the caret at 1: the new "a" went in at 0.
    assert.deepEqual(diffText('aa', 'aaa', 1), { index: 0, deleteCount: 0, text: 'a' });
    assert.deepEqual(diffText('aa', 'aaa', 2), { index: 1, deleteCount: 0, text: 'a' });
    assert.deepEqual(diffText('aa', 'aaa', 3), { index: 2, deleteCount: 0, text: 'a' });
    // Without a caret, the earliest difference.
    assert.deepEqual(diffText('aa', 'aaa'), { index: 2, deleteCount: 0, text: 'a' });
  });

  test('deleting from a run of the same letter deletes at the caret', () => {
    // Backspace at 2 in "aaa" leaves the caret at 1 and deletes index 1.
    assert.deepEqual(diffText('aaa', 'aa', 1), { index: 1, deleteCount: 1, text: '' });
    assert.deepEqual(diffText('aaa', 'aa', 0), { index: 0, deleteCount: 1, text: '' });
  });

  test('replacing a selection', () => {
    assert.deepEqual(diffText('hello world', 'hello x', 7), {
      index: 6,
      deleteCount: 5,
      text: 'x',
    });
    // The replacement shares its first letter with what it replaced: only the rest is the edit.
    assert.deepEqual(diffText('hello world', 'hello wave', 10), {
      index: 7,
      deleteCount: 4,
      text: 'ave',
    });
  });

  test('counts in code points, never splitting a surrogate pair', () => {
    // Two emoji that share their high surrogate: in UTF-16 they differ only in the second unit.
    assert.deepEqual(diffText('😀', '😁', 2), { index: 0, deleteCount: 1, text: '😁' });
    assert.deepEqual(diffText('a😀b', 'a😀😀b', 5), { index: 2, deleteCount: 0, text: '😀' });
    // A caret between the halves of a pair (never set by a browser) still gives a correct edit.
    assert.deepEqual(applyEdit('😀😀', diffText('😀😀', '😀😀😀', 3) as Edit), '😀😀😀');
  });

  test('any caret, even a wrong, out-of-range or non-integer one, gives an edit that turns before into after', () => {
    fc.assert(
      fc.property(
        text,
        text,
        fc.option(fc.oneof(fc.integer({ min: -3, max: 30 }), fc.double()), { nil: undefined }),
        (before, after, caret) => {
          const edit = diffText(before, after, caret);
          if (before === after) {
            assert.equal(edit, null);
            return;
          }
          assert.ok(edit !== null);
          assert.equal(applyEdit(before, edit), after);
          assert.ok(edit.deleteCount > 0 || edit.text !== '', 'an empty edit');
        },
      ),
      { numRuns: 5_000 },
    );
  });

  test('without a caret the edit is minimal: no common prefix or suffix left in it', () => {
    fc.assert(
      fc.property(text, text, (before, after) => {
        const edit = diffText(before, after);
        if (edit === null) return;
        const deleted = Array.from(before).slice(edit.index, edit.index + edit.deleteCount);
        const inserted = Array.from(edit.text);
        if (deleted.length > 0 && inserted.length > 0) {
          assert.notEqual(deleted[0], inserted[0]);
          assert.notEqual(deleted.at(-1), inserted.at(-1));
        }
      }),
      { numRuns: 5_000 },
    );
  });

  test('with the caret after the inserted text, it recovers the edit that was made', () => {
    fc.assert(
      fc.property(typed, ({ before, after, edit, caret }) => {
        const found = diffText(before, after, caret);
        if (before === after) {
          assert.equal(found, null);
          return;
        }
        assert.ok(found !== null);
        assert.equal(applyEdit(before, found), after);
        const deleted = Array.from(before).slice(edit.index, edit.index + edit.deleteCount);
        const inserted = Array.from(edit.text);
        // A pure insert or delete, or a replacement whose first code points differ, comes back exactly. (A
        // replacement that starts like what it replaced comes back smaller: the shared start isn't part of it.)
        if (deleted.length === 0 || inserted.length === 0 || deleted[0] !== inserted[0]) {
          if (!(deleted.length > 0 && inserted.length > 0 && deleted.at(-1) === inserted.at(-1))) {
            assert.deepEqual(found, edit);
          }
        }
      }),
      { numRuns: 10_000 },
    );
  });
});

describe('applyEdit', () => {
  test('refuses an edit outside the text', () => {
    assert.throws(() => applyEdit('ab', { index: 3, deleteCount: 0, text: 'x' }), RangeError);
    assert.throws(() => applyEdit('ab', { index: 1, deleteCount: 2, text: '' }), RangeError);
    assert.throws(() => applyEdit('ab', { index: -1, deleteCount: 0, text: '' }), RangeError);
    assert.equal(applyEdit('😀b', { index: 1, deleteCount: 1, text: 'c' }), '😀c');
  });
});

describe('offsets and code points', () => {
  test('surrogate pairs count once; an offset between the halves is before the pair', () => {
    const s = 'a😀b';
    assert.deepEqual(
      [0, 1, 2, 3, 4].map((o) => utf16ToCodePoint(s, o)),
      [0, 1, 1, 2, 3],
    );
    assert.deepEqual(
      [0, 1, 2, 3].map((i) => codePointToUtf16(s, i)),
      [0, 1, 3, 4],
    );
  });

  test('lone surrogates count as one code point each, as Array.from does', () => {
    const s = 'a\ud800b\udc00';
    assert.equal(utf16ToCodePoint(s, s.length), Array.from(s).length);
    assert.equal(codePointToUtf16(s, 4), 4);
  });

  test('refuse positions outside the text', () => {
    assert.throws(() => utf16ToCodePoint('ab', 3), RangeError);
    assert.throws(() => utf16ToCodePoint('ab', -1), RangeError);
    assert.throws(() => utf16ToCodePoint('ab', 0.5), RangeError);
    assert.throws(() => codePointToUtf16('😀', 2), RangeError);
    assert.throws(() => codePointToUtf16('ab', -1), RangeError);
  });

  test('convert back and forth at every code point boundary', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 20 }), (s) => {
        const n = Array.from(s).length;
        assert.equal(utf16ToCodePoint(s, s.length), n);
        for (let i = 0; i <= n; i++) {
          const offset = codePointToUtf16(s, i);
          assert.equal(offset, Array.from(s).slice(0, i).join('').length);
          assert.equal(utf16ToCodePoint(s, offset), i);
        }
      }),
    );
  });
});
