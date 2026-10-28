// Review 2 (at e96122f): what the encoder still lets past. 02940be made list() copy the array "by index", but it reads
// `value.length` afresh on every turn of the loop, after the length checks. An index getter that appends to the
// array (a plain Array, no Proxy) grows it past the limit mid-copy; the old `.map()` fixed its length at the start.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeClientMessage,
  encodeClientMessage,
  MAX_OPS,
  MAX_SPANS,
  ProtocolError,
  type ClientMessage,
} from '../src/protocol.ts';

/** The encoder either refuses the message or writes a text the decoder accepts. */
function encodesOnlyWhatDecodes(message: ClientMessage): void {
  let text: string;
  try {
    text = encodeClientMessage(message);
  } catch (error) {
    assert.ok(error instanceof ProtocolError, String(error));
    return;
  }
  assert.doesNotThrow(
    () => decodeClientMessage(text),
    `the encoder wrote a text the decoder refuses`,
  );
}

/** A one-item array whose first read appends `extra` more copies of the item. */
function growing<T>(item: T, extra: number): T[] {
  const items: T[] = [item];
  Object.defineProperty(items, 0, {
    get() {
      for (let i = 0; i < extra; i++) items.push(item);
      return item;
    },
    enumerable: true,
    configurable: true,
  });
  return items;
}

test('an ops array that grows while it is copied is refused, not written past MAX_OPS', () => {
  const insert = {
    type: 'insert',
    id: { replica: 'a', counter: 1 },
    origin: null,
    text: 'x',
  } as const;
  encodesOnlyWhatDecodes({ type: 'ops', ops: growing(insert, MAX_OPS) });
});

test('a spans array that grows while it is copied is refused, not written past MAX_SPANS', () => {
  const span = { replica: 'a', counter: 1, length: 1 };
  encodesOnlyWhatDecodes({
    type: 'ops',
    ops: [{ type: 'delete', spans: growing(span, MAX_SPANS) }],
  });
});

// Survivors of review 2's mutations, now pinned.

test('the second code-point count is skipped exactly when it cannot matter', () => {
  // op() counts code points again only when the counter is within MAX_INSERT_LENGTH of the top of the range. At
  // counter MAX - 9999 a 10,000-code-point run ends at MAX (fine); at MAX - 9998 it would end past it.
  const MAX = Number.MAX_SAFE_INTEGER;
  const run = (counter: number, text: string) =>
    JSON.stringify({
      type: 'ops',
      ops: [{ type: 'insert', id: { replica: 'a', counter }, origin: null, text }],
    });
  for (const unit of ['x', '😀']) {
    const text = unit.repeat(10_000);
    decodeClientMessage(run(MAX - 9_999, text));
    assert.throws(() => decodeClientMessage(run(MAX - 9_998, text)), /past the safe range/);
  }
});
