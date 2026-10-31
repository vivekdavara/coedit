import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import {
  ERROR_CODES,
  MAX_INSERT_LENGTH,
  MAX_OPS,
  MAX_SPAN_LENGTH,
  MAX_SPANS,
  PROTOCOL_VERSION,
  ProtocolError,
  codePoints,
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  validateOp,
  type ClientMessage,
  type Cursor,
  type Id,
  type Op,
  type ServerMessage,
} from '../src/protocol.ts';

const MAX = Number.MAX_SAFE_INTEGER;

// ---- Arbitraries for valid messages ----

/** fc.record, building ordinary objects like the decoder does (fast-check's default prototype is null). */
const record = <T>(model: { [K in keyof T]: fc.Arbitrary<T[K]> }): fc.Arbitrary<T> =>
  fc.record(model, { noNullPrototype: true });

const replica = fc.stringMatching(/^[A-Za-z0-9_-]{1,32}$/);
const doc = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/);
/** Counters near both ends of the range, where the off-by-ones live. */
const counter = (min: number, max: number) =>
  fc.oneof(
    fc.integer({ min, max: Math.min(max, min + 50) }),
    fc.integer({ min: Math.max(min, max - 50), max }),
    fc.integer({ min, max }),
  );
const id = (max = MAX): fc.Arbitrary<Id> => record({ replica, counter: counter(1, max) });

const insert: fc.Arbitrary<Op> = fc
  .tuple(fc.string({ unit: 'binary', minLength: 1, maxLength: 12 }), replica)
  .chain(([text, r]) =>
    counter(2, MAX - codePoints(text) + 1).chain((c) =>
      record({
        type: fc.constant('insert' as const),
        id: fc.constant({ replica: r, counter: c }),
        origin: fc.option(id(c - 1), { nil: null }),
        text: fc.constant(text),
      }),
    ),
  );

const span = fc
  .integer({ min: 1, max: MAX_SPAN_LENGTH })
  .chain((length) =>
    record({ replica, counter: counter(1, MAX - length + 1), length: fc.constant(length) }),
  );

const del: fc.Arbitrary<Op> = record({
  type: fc.constant('delete' as const),
  spans: fc.array(span, { minLength: 1, maxLength: 4 }),
});

const op = fc.oneof(insert, del);
const ops = fc.array(op, { minLength: 1, maxLength: 4 });
const cursor: fc.Arbitrary<Cursor | null> = fc.option(
  record({ anchor: fc.option(id(), { nil: null }), head: fc.option(id(), { nil: null }) }),
  { nil: null },
);

const clientMessage: fc.Arbitrary<ClientMessage> = fc.oneof(
  record({
    type: fc.constant('hello' as const),
    protocol: fc.integer({ min: 1, max: 3 }),
    doc,
    replica,
    have: counter(0, MAX),
  }),
  record({ type: fc.constant('ops' as const), ops }),
  record({ type: fc.constant('presence' as const), cursor }),
);

const serverMessage: fc.Arbitrary<ServerMessage> = fc.oneof(
  record({
    type: fc.constant('welcome' as const),
    protocol: fc.integer({ min: 1, max: 3 }),
    doc,
    seq: counter(0, MAX),
  }),
  ops.chain((list) =>
    record({
      type: fc.constant('ops' as const),
      from: counter(1, MAX - list.length + 1),
      ops: fc.constant(list),
    }),
  ),
  record({ type: fc.constant('presence' as const), replica, cursor }),
  record({
    type: fc.constant('error' as const),
    code: fc.constantFrom(...ERROR_CODES),
    message: fc.string({ unit: 'binary', maxLength: 40 }),
  }),
);

// ---- Helpers ----

const refusedClient = (text: string, path: string, problem: RegExp) => {
  assert.throws(
    () => decodeClientMessage(text),
    (error: unknown) => {
      assert.ok(error instanceof ProtocolError, `${text} threw ${String(error)}`);
      assert.equal(error.path, path, text);
      assert.match(error.message, problem, text);
      return true;
    },
  );
};

const hello = (fields: Record<string, unknown>) =>
  JSON.stringify({ type: 'hello', protocol: 1, doc: 'notes', replica: 'r1', have: 0, ...fields });
const insertOp = (fields: Record<string, unknown>) => ({
  type: 'insert',
  id: { replica: 'r1', counter: 5 },
  origin: { replica: 'r2', counter: 4 },
  text: 'hi',
  ...fields,
});
const opsMessage = (...list: unknown[]) => JSON.stringify({ type: 'ops', ops: list });

/** The same JSON with every object's keys in a random order. */
const shuffleKeys = (value: unknown, random: () => number): unknown => {
  if (Array.isArray(value)) return value.map((item) => shuffleKeys(item, random));
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value);
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [entries[i], entries[j]] = [entries[j] as [string, unknown], entries[i] as [string, unknown]];
  }
  return Object.fromEntries(entries.map(([k, v]) => [k, shuffleKeys(v, random)]));
};

// ---- Tests ----

describe('round trips', () => {
  test('client messages: decode(encode(m)) is m, and encoding is canonical', () => {
    fc.assert(
      fc.property(clientMessage, (message) => {
        const text = encodeClientMessage(message);
        const decoded = decodeClientMessage(text);
        assert.deepEqual(decoded, message);
        assert.equal(encodeClientMessage(decoded), text);
      }),
    );
  });

  test('server messages: decode(encode(m)) is m, and encoding is canonical', () => {
    fc.assert(
      fc.property(serverMessage, (message) => {
        const text = encodeServerMessage(message);
        const decoded = decodeServerMessage(text);
        assert.deepEqual(decoded, message);
        assert.equal(encodeServerMessage(decoded), text);
      }),
    );
  });

  test('key order and whitespace do not matter to the decoder', () => {
    fc.assert(
      fc.property(
        serverMessage,
        fc.integer({ min: 0, max: 2 }),
        fc.infiniteStream(fc.double({ min: 0, max: 0.999, noNaN: true })),
        (message, indent, stream) => {
          const it = stream[Symbol.iterator]();
          const shuffled = shuffleKeys(message, () => it.next().value as number);
          const text = JSON.stringify(shuffled, null, indent);
          assert.equal(
            encodeServerMessage(decodeServerMessage(text)),
            encodeServerMessage(message),
          );
        },
      ),
    );
  });

  test('the encoder writes keys in the specified order', () => {
    const message = { have: 3, replica: 'r1', doc: 'notes', protocol: 1, type: 'hello' } as const;
    assert.equal(
      encodeClientMessage(message),
      '{"type":"hello","protocol":1,"doc":"notes","replica":"r1","have":3}',
    );
    const op = {
      text: 'x',
      origin: null,
      id: { counter: 1, replica: 'a' },
      type: 'insert',
    } as const;
    assert.equal(
      encodeServerMessage({ ops: [op], from: 1, type: 'ops' }),
      '{"type":"ops","from":1,"ops":[{"type":"insert","id":{"replica":"a","counter":1},"origin":null,"text":"x"}]}',
    );
  });

  test('a text edited at random is refused, or decodes to a message that round-trips', () => {
    const alphabet = '{}[]":,0123456789-x \\';
    fc.assert(
      fc.property(
        clientMessage,
        fc.nat(),
        fc.integer({ min: 0, max: alphabet.length - 1 }),
        fc.constantFrom('replace', 'insert', 'delete'),
        (message, at, pick, edit) => {
          const text = encodeClientMessage(message);
          const i = at % text.length;
          const c = alphabet.charAt(pick);
          const edited =
            edit === 'replace'
              ? text.slice(0, i) + c + text.slice(i + 1)
              : edit === 'insert'
                ? text.slice(0, i) + c + text.slice(i)
                : text.slice(0, i) + text.slice(i + 1);
          let decoded: ClientMessage;
          try {
            decoded = decodeClientMessage(edited);
          } catch (error) {
            assert.ok(error instanceof ProtocolError, String(error));
            return;
          }
          assert.deepEqual(decodeClientMessage(encodeClientMessage(decoded)), decoded);
        },
      ),
      { numRuns: 5_000 },
    );
  });
});

describe('the decoder refuses', () => {
  test('text that is not JSON, or not an object, or of an unknown type', () => {
    refusedClient('{"type":"hello",', '', /not valid JSON: unexpected end/);
    refusedClient('{"type":"ops","ops":[],"ops":[]}', '', /duplicate key "ops"/);
    refusedClient('[]', '', /must be an object/);
    refusedClient('{}', 'type', /missing/);
    refusedClient('{"type":"welcome"}', 'type', /must be one of hello, ops, presence/);
    refusedClient('{"type":1}', 'type', /must be one of/);
  });

  test('missing and unknown fields', () => {
    refusedClient('{"type":"hello","protocol":1,"doc":"d","replica":"r"}', 'have', /missing/);
    refusedClient(hello({ extra: 1 }), 'extra', /unknown field/);
    refusedClient(opsMessage(insertOp({ extra: 1 })), 'ops[0].extra', /unknown field/);
    refusedClient(
      opsMessage(insertOp({ id: { replica: 'r1', counter: 5, x: 0 } })),
      'ops[0].id.x',
      /unknown field/,
    );
  });

  test('bad hello fields', () => {
    refusedClient(hello({ protocol: 0 }), 'protocol', /from 1/);
    refusedClient(hello({ protocol: '1' }), 'protocol', /must be an integer/);
    refusedClient(hello({ have: -1 }), 'have', /from 0/);
    refusedClient(hello({ doc: '' }), 'doc', /1 to 64 characters/);
    refusedClient(hello({ doc: 'a'.repeat(65) }), 'doc', /1 to 64/);
    refusedClient(hello({ doc: 'a b' }), 'doc', /A-Z a-z 0-9 _ -/);
    refusedClient(hello({ doc: 'café' }), 'doc', /A-Z a-z 0-9 _ -/);
    refusedClient(hello({ doc: 'a\n' }), 'doc', /A-Z a-z 0-9 _ -/);
    refusedClient(hello({ replica: 'r'.repeat(33) }), 'replica', /1 to 32/);
    refusedClient(hello({ replica: null }), 'replica', /must be a string/);
    // Exactly at the limits is fine.
    decodeClientMessage(hello({ doc: 'a'.repeat(64), replica: 'r'.repeat(32), have: MAX }));
  });

  test("an insert whose counter isn't above its origin's", () => {
    const origin = (counter: number) => ({ replica: 'r2', counter });
    refusedClient(
      opsMessage(insertOp({ origin: origin(5) })),
      'ops[0].origin.counter',
      /less than the insert's/,
    );
    refusedClient(
      opsMessage(insertOp({ origin: origin(6) })),
      'ops[0].origin.counter',
      /less than/,
    );
    // Same counter from the same replica is the same element: still refused.
    refusedClient(
      opsMessage(insertOp({ origin: { replica: 'r1', counter: 5 } })),
      'ops[0].origin.counter',
      /less than/,
    );
    decodeClientMessage(opsMessage(insertOp({ origin: origin(4) })));
    decodeClientMessage(opsMessage(insertOp({ origin: null, id: { replica: 'r1', counter: 1 } })));
  });

  test('insert text: empty, too long, past the counter range', () => {
    refusedClient(opsMessage(insertOp({ text: '' })), 'ops[0].text', /1 to 10000 code points/);
    refusedClient(
      opsMessage(insertOp({ text: 'x'.repeat(MAX_INSERT_LENGTH + 1) })),
      'ops[0].text',
      /code points/,
    );
    decodeClientMessage(opsMessage(insertOp({ text: 'x'.repeat(MAX_INSERT_LENGTH) })));
    // Counted in code points: 10,000 emoji are 20,000 UTF-16 units and still fit; one more doesn't.
    decodeClientMessage(opsMessage(insertOp({ text: '😀'.repeat(MAX_INSERT_LENGTH) })));
    refusedClient(
      opsMessage(insertOp({ text: '😀'.repeat(MAX_INSERT_LENGTH + 1) })),
      'ops[0].text',
      /code points/,
    );
    refusedClient(
      opsMessage(insertOp({ text: '😀'.repeat(MAX_INSERT_LENGTH) + 'x' })),
      'ops[0].text',
      /code points/,
    );
    // The run's ids are counter .. counter + length - 1.
    decodeClientMessage(opsMessage(insertOp({ id: { replica: 'r1', counter: MAX }, text: 'x' })));
    refusedClient(
      opsMessage(insertOp({ id: { replica: 'r1', counter: MAX }, text: 'xy' })),
      'ops[0].text',
      /past the safe range/,
    );
    refusedClient(
      opsMessage(insertOp({ id: { replica: 'r1', counter: MAX - 1 }, text: '😀😀😀' })),
      'ops[0].text',
      /past the safe range/,
    );
  });

  test('a lone surrogate in insert text, escaped', () => {
    refusedClient(
      String.raw`{"type":"ops","ops":[{"type":"insert","id":{"replica":"a","counter":1},"origin":null,"text":"\ud800"}]}`,
      '',
      /lone surrogate/,
    );
  });

  test('bad deletes', () => {
    const del = (spans: unknown) => opsMessage({ type: 'delete', spans });
    const s = (counter: number, length: number) => ({ replica: 'r', counter, length });
    refusedClient(del([]), 'ops[0].spans', /must not be empty/);
    refusedClient(del({}), 'ops[0].spans', /must be an array/);
    refusedClient(del([s(1, 0)]), 'ops[0].spans[0].length', /from 1 to 10000/);
    refusedClient(del([s(1, MAX_SPAN_LENGTH + 1)]), 'ops[0].spans[0].length', /from 1 to 10000/);
    refusedClient(del([s(0, 1)]), 'ops[0].spans[0].counter', /from 1/);
    refusedClient(del([s(1, 1), s(MAX, 2)]), 'ops[0].spans[1].length', /past the safe range/);
    refusedClient(
      del(Array.from({ length: MAX_SPANS + 1 }, () => s(1, 1))),
      'ops[0].spans',
      /more than 1000/,
    );
    decodeClientMessage(del([s(MAX, 1), s(MAX - MAX_SPAN_LENGTH + 1, MAX_SPAN_LENGTH)]));
    decodeClientMessage(del(Array.from({ length: MAX_SPANS }, () => s(1, 1))));
  });

  test('ops lists: empty, too long, a bad op deep inside', () => {
    refusedClient(opsMessage(), 'ops', /must not be empty/);
    const many = Array.from({ length: MAX_OPS + 1 }, () => insertOp({}));
    refusedClient(opsMessage(...many), 'ops', /more than 1000/);
    decodeClientMessage(opsMessage(...many.slice(1)));
    refusedClient(
      opsMessage(insertOp({}), { type: 'move' }),
      'ops[1].type',
      /must be one of insert, delete/,
    );
    refusedClient(opsMessage(insertOp({}), 7), 'ops[1]', /must be an object/);
  });

  test('bad presence', () => {
    const presence = (cursor: unknown) => JSON.stringify({ type: 'presence', cursor });
    decodeClientMessage(presence(null));
    decodeClientMessage(presence({ anchor: null, head: { replica: 'r', counter: 3 } }));
    refusedClient(presence({ anchor: null }), 'cursor.head', /missing/);
    refusedClient(
      presence({ anchor: null, head: { replica: 'r', counter: 0 } }),
      'cursor.head.counter',
      /from 1/,
    );
    refusedClient(presence('here'), 'cursor', /must be an object/);
  });

  test('server-only checks', () => {
    const refused = (message: unknown, path: string, problem: RegExp) => {
      assert.throws(
        () => decodeServerMessage(JSON.stringify(message)),
        (error: unknown) => {
          assert.ok(error instanceof ProtocolError);
          assert.equal(error.path, path);
          assert.match(error.message, problem);
          return true;
        },
      );
    };
    const op = insertOp({});
    refused({ type: 'collected', spans: [] }, 'spans', /must not be empty/);
    refused(
      { type: 'collected', spans: [{ replica: 'r', counter: 0, length: 1 }] },
      'spans[0].counter',
      /from 1/,
    );
    refused(
      { type: 'collected', spans: [{ replica: 'r', counter: 1, length: 1 }], x: 1 },
      'x',
      /unknown/,
    );
    refused(
      {
        type: 'collected',
        spans: Array.from({ length: 1001 }, () => ({ replica: 'r', counter: 1, length: 1 })),
      },
      'spans',
      /more than 1000/,
    );
    refused({ type: 'snapshot', seq: -1, ops: [], last: true }, 'seq', /from 0/);
    refused({ type: 'snapshot', seq: 1, ops: [], last: 1 }, 'last', /true or false/);
    refused({ type: 'snapshot', seq: 1, ops: [] }, 'last', /missing/);
    refused({ type: 'snapshot', seq: 1, ops: [op], last: true, more: 1 }, 'more', /unknown/);
    refused({ type: 'snapshot', seq: 1, ops: {}, last: true }, 'ops', /array/);
    refused(
      { type: 'snapshot', seq: 1, ops: [{ type: 'insert' }], last: true },
      'ops[0].id',
      /missing/,
    );
    refused({ type: 'ops', from: 0, ops: [op] }, 'from', /from 1/);
    refused({ type: 'ops', from: MAX, ops: [op, op] }, 'from', /past the safe range/);
    decodeServerMessage(JSON.stringify({ type: 'ops', from: MAX, ops: [op] }));
    refused({ type: 'error', code: 'nope', message: '' }, 'code', /must be one of malformed/);
    refused(
      { type: 'error', code: 'malformed', message: 'x'.repeat(1001) },
      'message',
      /0 to 1000/,
    );
    refused(
      { type: 'hello', protocol: 1, doc: 'd', replica: 'r', have: 0 },
      'type',
      /must be one of welcome/,
    );
    refused({ type: 'presence', cursor: null }, 'replica', /missing/);
  });
});

describe('the encoder refuses what the decoder would', () => {
  const refused = (message: unknown, path: string, problem: RegExp) => {
    assert.throws(
      () => encodeClientMessage(message as ClientMessage),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolError);
        assert.equal(error.path, path);
        assert.match(error.message, problem);
        return true;
      },
    );
  };

  test('values JSON cannot carry exactly', () => {
    const base = { type: 'hello', protocol: PROTOCOL_VERSION, doc: 'd', replica: 'r', have: 0 };
    refused({ ...base, have: Number.NaN }, 'have', /integer/);
    refused({ ...base, have: Infinity }, 'have', /integer/);
    refused({ ...base, have: -0 }, 'have', /integer/);
    refused({ ...base, have: 0.5 }, 'have', /integer/);
    refused({ ...base, have: MAX + 1 }, 'have', /integer/);
    refused({ type: 'ops', ops: [insertOp({ text: 'a\ud800' })] }, 'ops[0].text', /lone surrogate/);
  });

  test('extra and missing fields, even undefined ones', () => {
    refused({ type: 'presence', cursor: null, extra: undefined }, 'extra', /unknown field/);
    refused({ type: 'presence' }, 'cursor', /missing/);
  });

  test('validateOp checks a single operation', () => {
    assert.deepEqual(
      validateOp({ type: 'delete', spans: [{ length: 2, counter: 1, replica: 'r' }] }),
      {
        type: 'delete',
        spans: [{ replica: 'r', counter: 1, length: 2 }],
      },
    );
    assert.throws(() => validateOp({ type: 'delete', spans: [] }), /op\.spans: must not be empty/);
  });
});

describe('codePoints', () => {
  test('counts a surrogate pair once', () => {
    assert.equal(codePoints(''), 0);
    assert.equal(codePoints('abc'), 3);
    assert.equal(codePoints('a😀b'), 3);
    assert.equal(codePoints('👍🏽'), 2);
  });

  test('agrees with the string iterator on well-formed strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        assert.equal(codePoints(s), Array.from(s).length);
      }),
    );
  });
});

describe("the server's collected message", () => {
  test('round-trips through the encoder and decoder', () => {
    const message = {
      type: 'collected' as const,
      spans: [
        { replica: 'a', counter: 1, length: 3 },
        { replica: 'b', counter: 2 ** 53 - 10, length: 10 },
      ],
    };
    const text = encodeServerMessage(message);
    assert.equal(
      text,
      '{"type":"collected","spans":[{"replica":"a","counter":1,"length":3},{"replica":"b","counter":9007199254740982,"length":10}]}',
    );
    assert.deepEqual(decodeServerMessage(text), message);
  });

  test('the error code resync is one a server may send', () => {
    const text = encodeServerMessage({ type: 'error', code: 'resync', message: 'x' });
    assert.deepEqual(decodeServerMessage(text), { type: 'error', code: 'resync', message: 'x' });
  });
});
