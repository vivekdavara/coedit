// Review 1: diffText against its documentation. The first version's comment said the caret "only chooses among the
// equally small" edits, and a NaN or fractional caret threw RangeError.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import { codePointToUtf16, diffText, utf16ToCodePoint } from '../src/edit.ts';

describe('review 1: diffText', () => {
  test('with the caret after a replacement, the edit is what was typed, even if bigger than the smallest', () => {
    // "orld" replaced by "and", caret right after it (where the browser leaves it).
    assert.deepEqual(diffText('hello world', 'hello wand', 10), {
      index: 7,
      deleteCount: 4,
      text: 'and',
    });
    // Without the caret, the smallest edit keeps the old "d".
    assert.deepEqual(diffText('hello world', 'hello wand'), {
      index: 7,
      deleteCount: 3,
      text: 'an',
    });
  });

  test('a NaN or fractional caret counts as no caret', () => {
    for (const caret of [Number.NaN, 1.5, Infinity, -Infinity]) {
      assert.deepEqual(diffText('ab', 'abc', caret), diffText('ab', 'abc'), `caret ${caret}`);
    }
    // One where rounding would give a different answer (review 2: rounding passed the cases above). With no caret,
    // the insert into "aa" goes last; a caret rounded to 1 would put it first.
    assert.deepEqual(diffText('aa', 'aaa', 1.4), { index: 2, deleteCount: 0, text: 'a' });
    assert.deepEqual(diffText('aa', 'aaa', 1), { index: 0, deleteCount: 0, text: 'a' });
  });
});

// Kills a mutation of codePointToUtf16 that paired a lone low surrogate with a following one: fast-check's 'binary'
// strings never contain a lone surrogate, so the back-and-forth property never saw one.
test('conversions agree with Array.from on strings with lone surrogates', () => {
  const unit = fc.constantFrom('a', '😀', '\ud83d', '\ude00', '\udc00', '\udbff');
  fc.assert(
    fc.property(fc.string({ unit, maxLength: 12 }), (s) => {
      const points = Array.from(s);
      assert.equal(utf16ToCodePoint(s, s.length), points.length);
      for (let i = 0; i <= points.length; i++) {
        assert.equal(codePointToUtf16(s, i), points.slice(0, i).join('').length, JSON.stringify(s));
      }
    }),
    { numRuns: 2_000 },
  );
});
