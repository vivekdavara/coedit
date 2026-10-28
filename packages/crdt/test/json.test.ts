import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import { JsonError, MAX_DEPTH, parseJson, type JsonValue } from '../src/json.ts';

/** `JSON.stringify` of a value, which for both readers' output means: same keys, order and values. */
const same = (a: unknown, b: unknown) => {
  assert.equal(JSON.stringify(a), JSON.stringify(b));
};

const refused = (text: string, reason: RegExp) => {
  assert.throws(
    () => parseJson(text),
    (error: unknown) => {
      assert.ok(error instanceof JsonError, `${JSON.stringify(text)} threw ${String(error)}`);
      assert.match(error.message, reason, JSON.stringify(text));
      return true;
    },
  );
};

/** JSON values inside what the reader accepts: safe integers (no -0) and well-formed strings. */
const accepted: fc.Arbitrary<JsonValue> = fc.letrec<{ value: JsonValue }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.constant(null),
    fc.boolean(),
    fc.maxSafeInteger().map((n) => (Object.is(n, -0) ? 0 : n)),
    fc.string({ unit: 'binary' }),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.string({ unit: 'binary', maxLength: 4 }), tie('value'), { maxKeys: 4 }),
  ),
})).value;

describe('parseJson accepts', () => {
  test('every kind of value', () => {
    same(parseJson('{"a":[1,-2,true,false,null,"x"],"b":{}}'), {
      a: [1, -2, true, false, null, 'x'],
      b: {},
    });
    assert.equal(parseJson(' \t\r\n7 \n'), 7);
    assert.ok(Array.isArray(parseJson('[]')));
  });

  test('every escape, and a surrogate pair written as two escapes', () => {
    assert.equal(
      parseJson(String.raw`"\" \\ \/ \b \f \n \r \t \u0041 \ud83d\ude00"`),
      '" \\ / \b \f \n \r \t A 😀',
    );
  });

  test('the largest safe integers', () => {
    assert.equal(parseJson('9007199254740991'), Number.MAX_SAFE_INTEGER);
    assert.equal(parseJson('-9007199254740991'), -Number.MAX_SAFE_INTEGER);
  });

  test('"__proto__" as an ordinary key', () => {
    const value = parseJson('{"__proto__":{"polluted":1}}') as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(value), null);
    assert.deepEqual(Object.keys(value), ['__proto__']);
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });

  test(`nesting up to ${MAX_DEPTH} levels`, () => {
    const text = '['.repeat(MAX_DEPTH) + ']'.repeat(MAX_DEPTH);
    same(parseJson(text), JSON.parse(text));
  });

  test('the same values as JSON.parse, with any whitespace', () => {
    fc.assert(
      fc.property(accepted, fc.integer({ min: 0, max: 3 }), (value, indent) => {
        const text = JSON.stringify(value, null, indent);
        same(parseJson(text), JSON.parse(text));
      }),
    );
  });
});

describe('parseJson refuses', () => {
  test('duplicate keys, at any depth', () => {
    refused('{"a":1,"a":2}', /duplicate key "a" at offset 7/);
    refused('[{"x":{"k":1,"k":1}}]', /duplicate key "k"/);
    // Distinct after unescaping is what counts.
    refused(String.raw`{"a":1,"\u0061":2}`, /duplicate key "a"/);
  });

  test('lone surrogates, escaped or raw', () => {
    refused(String.raw`"\ud800"`, /lone surrogate/);
    refused(String.raw`"\ude00\ud83d"`, /lone surrogate/);
    refused('"\ud800"', /lone surrogate/);
    refused(String.raw`{"\udfff":1}`, /lone surrogate/);
  });

  test('numbers it would round or the protocol never uses', () => {
    refused('9007199254740992', /safe range/);
    refused('-9007199254740992', /safe range/);
    refused('1' + '0'.repeat(400), /safe range/);
    refused('-0', /negative zero/);
    refused('1.0', /integers only/);
    refused('1e3', /integers only/);
    refused('1E3', /integers only/);
    refused('01', /leading zero/);
    refused('-', /bad number/);
    refused('+1', /unexpected character/);
  });

  test('malformed text', () => {
    refused('', /unexpected end/);
    refused('   ', /unexpected end/);
    refused('\ufeff{}', /byte order mark/);
    refused('{}{}', /after the value/);
    refused('{"a" 1}', /expected ':'/);
    refused('{"a":1,}', /expected a string key/);
    refused('{a:1}', /expected a string key/);
    refused('[1,]', /unexpected character "]"/);
    refused('[1 2]', /expected ',' or ']'/);
    refused('{"a":1 "b":2}', /expected ',' or '}'/);
    refused('"abc', /unterminated string at offset 0/);
    refused('"a\nb"', /control character/);
    refused(String.raw`"\x41"`, /bad escape/);
    refused(String.raw`"\u12G4"`, /bad \\u escape/);
    refused(String.raw`"\u12"`, /bad \\u escape/);
    refused('"\\', /bad escape/);
    refused('tru', /expected true/);
    refused('nul', /expected null/);
    refused("'a'", /unexpected character/);
    refused('NaN', /unexpected character/);
  });

  test(`nesting deeper than ${MAX_DEPTH}`, () => {
    refused('['.repeat(MAX_DEPTH + 1) + ']'.repeat(MAX_DEPTH + 1), /nested deeper/);
    refused('{"a":'.repeat(MAX_DEPTH + 1) + '1' + '}'.repeat(MAX_DEPTH + 1), /nested deeper/);
    // Deep enough to overflow the stack of a reader without the limit.
    refused('['.repeat(1_000_000), /nested deeper/);
  });

  test('only what JSON.parse refuses or would read differently', () => {
    // Random texts over JSON's alphabet: wherever this reader accepts, JSON.parse must accept and agree. The
    // units are UTF-16 code units on purpose, so the two surrogate halves also come alone and in either order.
    const alphabet = '{}[]":,0123456789-.eE \\utrfalsn\ud800\udc00a';
    const unit = fc.integer({ min: 0, max: alphabet.length - 1 }).map((i) => alphabet.charAt(i));
    fc.assert(
      fc.property(fc.string({ unit, maxLength: 24 }), (text) => {
        let ours: JsonValue;
        try {
          ours = parseJson(text);
        } catch (error) {
          assert.ok(error instanceof JsonError);
          return;
        }
        same(ours, JSON.parse(text));
      }),
      { numRuns: 20_000 },
    );
  });
});
