// Review 1: the encoder must refuse whatever the decoder would refuse, whatever object it is handed, and tests
// that kill mutations the suite let survive.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { JsonError, parseJson } from '../src/json.ts';
import {
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  type ClientMessage,
} from '../src/protocol.ts';

/** encode must either throw, or write a text the decoder accepts. */
const encoderAgrees = (message: unknown) => {
  let text: string;
  try {
    text = encodeClientMessage(message as ClientMessage);
  } catch {
    return;
  }
  assert.doesNotThrow(() => decodeClientMessage(text), `encoder wrote ${text}`);
};

describe('review 1: encoder vs decoder on odd arrays', () => {
  test('an ops array with its own map property', () => {
    // list() checks Array.isArray and the length, then calls the caller's own value.map.
    const ops: unknown[] = [{ type: 'delete', spans: [{ replica: 'r', counter: 1, length: 1 }] }];
    Object.defineProperty(ops, 'map', {
      value: () => [
        { type: 'insert', id: { replica: 'a b', counter: 0.5 }, origin: null, text: '\ud800' },
      ],
    });
    encoderAgrees({ type: 'ops', ops });
  });

  test('an Array subclass with toJSON (map keeps the species)', () => {
    class Tagged extends Array<unknown> {
      toJSON() {
        return 'not an array';
      }
    }
    const ops = Tagged.from([{ type: 'delete', spans: [{ replica: 'r', counter: 1, length: 1 }] }]);
    encoderAgrees({ type: 'ops', ops });
  });
});
test('parseJson refuses escapes and whitespace JSON.parse refuses (kills J2, J3, J4)', () => {
  for (const text of [
    '"\\v"',
    '"\\\'"',
    '"\\0"',
    '"\\x41"',
    '[\u000b1]',
    '[ 1]',
    ' 1',
    '[1\u000c]',
  ]) {
    assert.throws(() => JSON.parse(text), SyntaxError, JSON.stringify(text));
    assert.throws(() => parseJson(text), JsonError, JSON.stringify(text));
  }
});

test('welcome with seq 0 (an empty log) round-trips (kills P11)', () => {
  const message = { type: 'welcome', protocol: 1, doc: 'd', seq: 0 } as const;
  assert.deepEqual(decodeServerMessage(encodeServerMessage(message)), message);
});
