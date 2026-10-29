import type { Change } from '../../src/rga.ts';

/** Applies visible changes, in order, to a text, in code points: what the client will do to its textarea. */
export function replay(text: string, changes: readonly Change[]): string {
  const chars = Array.from(text);
  for (const c of changes) {
    if (!Number.isSafeInteger(c.index) || c.index < 0 || c.index > chars.length) {
      throw new RangeError(`${JSON.stringify(c)} is outside a text of ${chars.length}`);
    }
    if (c.type === 'insert') {
      if (c.text === '') throw new RangeError(`${JSON.stringify(c)} inserts nothing`);
      chars.splice(c.index, 0, ...Array.from(c.text));
    } else {
      if (!Number.isSafeInteger(c.count) || c.count < 1 || c.index + c.count > chars.length) {
        throw new RangeError(`${JSON.stringify(c)} deletes past a text of ${chars.length}`);
      }
      chars.splice(c.index, c.count);
    }
  }
  return chars.join('');
}
