/**
 * Turning a textarea's input into one edit, and positions between the textarea's UTF-16 offsets and the CRDT's
 * code points (DESIGN.md "The client").
 *
 * The browser tells us the text before and after an input event, and where the caret ended up; it doesn't say
 * what changed. Comparing the two texts finds the changed span, but not always uniquely: typing "a" into "aa"
 * gives "aaa" whichever position it went in. The caret settles it, because after typing, pasting, deleting or
 * replacing a selection the caret sits right after the inserted text. Where it matters, which position is chosen
 * decides whose text a concurrent edit lands next to.
 */

/** Delete `deleteCount` code points from `index`, then insert `text` there. */
export interface Edit {
  readonly index: number;
  readonly deleteCount: number;
  readonly text: string;
}

/**
 * The edit that turns `before` into `after`, or null if they're equal. `caret` is the caret's UTF-16 offset in
 * `after` (the textarea's `selectionEnd` after the input).
 *
 * Without a caret the edit is the smallest one: the common prefix, then the common suffix of what remains. With
 * one, the inserted text is made to end at the caret where it can, which is where the browser leaves it after
 * typing, pasting, deleting or replacing a selection. In a run of equal characters that picks the position actually
 * typed at; it can also make the edit bigger than the smallest, and then it's the edit that was made: replacing
 * "orld" in "hello world" by "and" (caret after it) gives delete 4, insert "and", not delete 3, insert "an" keeping
 * the old "d". Any caret, even a wrong, out-of-range or non-integer one (treated as none), still gives an edit that
 * turns `before` into `after`.
 */
export function diffText(before: string, after: string, caret?: number): Edit | null {
  if (before === after) return null;
  if (caret !== undefined && !Number.isInteger(caret)) caret = undefined;
  const b = Array.from(before);
  const a = Array.from(after);
  const shorter = Math.min(a.length, b.length);
  let prefix = 0;
  let suffix = 0;
  if (caret === undefined) {
    while (prefix < shorter && a[prefix] === b[prefix]) prefix++;
    while (suffix < shorter - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix])
      suffix++;
  } else {
    // The inserted text ends at the caret, so the common suffix may not reach left of it. Taking the suffix first
    // and the prefix from what's left puts an ambiguous insert or delete at the caret.
    const atCaret = utf16ToCodePoint(after, Math.max(0, Math.min(caret, after.length)));
    const maxSuffix = a.length - atCaret;
    while (
      suffix < Math.min(shorter, maxSuffix) &&
      a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
    )
      suffix++;
    while (prefix < shorter - suffix && a[prefix] === b[prefix]) prefix++;
  }
  return {
    index: prefix,
    deleteCount: b.length - prefix - suffix,
    text: a.slice(prefix, a.length - suffix).join(''),
  };
}

/** Applies an edit to a text, in code points. */
export function applyEdit(text: string, edit: Edit): string {
  const points = Array.from(text);
  if (edit.index < 0 || edit.deleteCount < 0 || edit.index + edit.deleteCount > points.length) {
    throw new RangeError(
      `edit ${JSON.stringify(edit)} is outside a text of ${points.length} code points`,
    );
  }
  points.splice(edit.index, edit.deleteCount, edit.text);
  return points.join('');
}

/**
 * The number of whole code points before UTF-16 offset `offset` (0 to `text.length`). An offset between the two
 * halves of a surrogate pair counts the pair as not yet reached.
 */
export function utf16ToCodePoint(text: string, offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
    throw new RangeError(`offset ${offset} is outside a text of ${text.length} UTF-16 units`);
  }
  let points = 0;
  for (let i = 0; i < offset; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        if (i + 1 === offset) break; // between the halves
        i++;
      }
    }
    points++;
  }
  return points;
}

/** The UTF-16 offset where code point `index` starts (`index` from 0 to the number of code points). */
export function codePointToUtf16(text: string, index: number): number {
  if (!Number.isInteger(index) || index < 0)
    throw new RangeError(`index ${index} is not a code point index`);
  let offset = 0;
  for (let n = 0; n < index; n++) {
    if (offset >= text.length) {
      throw new RangeError(`index ${index} is past the end of a text of ${n} code points`);
    }
    const c = text.charCodeAt(offset);
    const next = text.charCodeAt(offset + 1);
    offset += c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
  }
  return offset;
}
