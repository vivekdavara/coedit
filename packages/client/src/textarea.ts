/**
 * Remote changes applied to what the textarea shows: its text and its selection (DESIGN.md "The client"). The CRDT
 * reports changes in code points; the textarea counts UTF-16 units, so each change is converted against the text as
 * it is just before that change.
 *
 * Where a position goes:
 * - an insert strictly before it shifts it right by the inserted length; an insert exactly at it leaves it where it
 *   is, before the new text. The caret means "just after the element before me", and the new text was placed after
 *   that element too, so the caret stays next to it (and the next character typed goes there, before the new text).
 * - a delete before it shifts it left; a delete around it pulls it to where the deleted text began.
 */
import type { Change } from '@coedit/crdt';
import { codePointToUtf16 } from './edit.ts';

/** A textarea's selection in UTF-16 units, as `selectionStart`, `selectionEnd` and `selectionDirection` give it. */
export interface TextareaState {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Applies `changes` in order to the text, moving the selection with them. */
export function applyChanges(state: TextareaState, changes: readonly Change[]): TextareaState {
  let { text, start, end } = state;
  for (const change of changes) {
    const at = codePointToUtf16(text, change.index);
    if (change.type === 'insert') {
      text = text.slice(0, at) + change.text + text.slice(at);
      const shift = (p: number) => (p > at ? p + change.text.length : p);
      start = shift(start);
      end = shift(end);
    } else {
      const to = codePointToUtf16(text, change.index + change.count);
      text = text.slice(0, at) + text.slice(to);
      const shift = (p: number) => (p <= at ? p : p >= to ? p - (to - at) : at);
      start = shift(start);
      end = shift(end);
    }
  }
  return { text, start, end };
}

/** A stable color for a replica id: a hue from a hash of it. */
export function replicaHue(replica: string): number {
  let hash = 2166136261;
  for (let i = 0; i < replica.length; i++) {
    hash ^= replica.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}
