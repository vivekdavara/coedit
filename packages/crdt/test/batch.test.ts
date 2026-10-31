// Operations kept as their canonical text, the messages written from them, and batches that fit one message
// (protocol.ts: encodeOp, encodeClientOps, encodeServerOps, batchOps, utf8Length).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import {
  MAX_MESSAGE_BYTES,
  MAX_OPS,
  ProtocolError,
  batchEnd,
  batchOps,
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeClientOps,
  encodeOp,
  encodeServerMessage,
  encodeServerOps,
  utf8Length,
  type Op,
} from '../src/protocol.ts';

const ins = (counter: number, text: string): Op => ({
  type: 'insert',
  id: { replica: 'r', counter },
  origin: counter === 1 ? null : { replica: 'r', counter: counter - 1 },
  text,
});

describe('encodeOp and the messages written from it', () => {
  const ops: Op[] = [
    ins(1, 'ab"\\\n\u0000é😀'),
    { type: 'delete', spans: [{ replica: 'r', counter: 1, length: 2 }] },
  ];

  test('writes the canonical text, whatever order the keys came in', () => {
    const shuffled = { text: 'x', origin: null, id: { counter: 1, replica: 'r' }, type: 'insert' };
    assert.equal(
      encodeOp(shuffled as Op),
      '{"type":"insert","id":{"replica":"r","counter":1},"origin":null,"text":"x"}',
    );
  });

  test('refuses an operation the decoder would refuse', () => {
    assert.throws(() => encodeOp(ins(1, '\ud800')), ProtocolError);
  });

  test("the server's ops message is the text encodeServerMessage writes", () => {
    for (const from of [1, 77, Number.MAX_SAFE_INTEGER - 1]) {
      const text = encodeServerOps(from, ops.map(encodeOp));
      assert.equal(text, encodeServerMessage({ type: 'ops', from, ops }));
      assert.deepEqual(decodeServerMessage(text), { type: 'ops', from, ops });
    }
  });

  test("the client's ops message is the text encodeClientMessage writes", () => {
    const text = encodeClientOps(ops.map(encodeOp));
    assert.equal(text, encodeClientMessage({ type: 'ops', ops }));
    assert.deepEqual(decodeClientMessage(text), { type: 'ops', ops });
  });

  test('refuses an empty batch, one too large, and numbers past the safe range', () => {
    const one = encodeOp(ins(1, 'x'));
    assert.throws(() => encodeClientOps([]), ProtocolError);
    assert.throws(() => encodeServerOps(1, []), ProtocolError);
    assert.throws(() => encodeClientOps(Array<string>(MAX_OPS + 1).fill(one)), ProtocolError);
    assert.throws(() => encodeServerOps(0, [one]), ProtocolError);
    assert.throws(() => encodeServerOps(Number.MAX_SAFE_INTEGER, [one, one]), ProtocolError);
    assert.doesNotThrow(() => encodeServerOps(Number.MAX_SAFE_INTEGER, [one]));
  });
});

describe('batchOps', () => {
  test('nothing makes no batches', () => {
    assert.deepEqual(batchOps([]), []);
  });

  test('splits at MAX_OPS operations', () => {
    const texts = Array.from({ length: 2_500 }, (_, i) => encodeOp(ins(i + 1, 'x')));
    const batches = batchOps(texts);
    assert.deepEqual(
      batches.map((b) => b.length),
      [1_000, 1_000, 500],
    );
    assert.deepEqual(batches.flat(), texts);
  });

  test('splits by bytes, and every batch fits one message with the longest sequence number', () => {
    // 10,000 code points of 4 UTF-8 bytes each, escaped quotes, control characters (6 bytes each as \u0000).
    const heavy = ['😀'.repeat(10_000), '"'.repeat(10_000), '\u0001'.repeat(10_000)];
    const texts = Array.from({ length: 120 }, (_, i) =>
      encodeOp(ins(i * 10_000 + 1, heavy[i % 3] as string)),
    );
    const batches = batchOps(texts);
    assert.ok(batches.length > 1);
    assert.deepEqual(batches.flat(), texts);
    for (const batch of batches) {
      const from = Number.MAX_SAFE_INTEGER - batch.length + 1;
      assert.ok(utf8Length(encodeServerOps(from, batch)) <= MAX_MESSAGE_BYTES);
      assert.ok(utf8Length(encodeClientOps(batch)) <= MAX_MESSAGE_BYTES);
    }
    // Greedy: each batch but the last is full enough that the next operation wouldn't fit.
    for (let i = 0; i + 1 < batches.length; i++) {
      const batch = batches[i] as string[];
      const next = (batches[i + 1] as string[])[0] as string;
      assert.ok(utf8Length(encodeServerOps(1, [...batch, next])) > MAX_MESSAGE_BYTES - 64);
    }
  });

  test('at the exact byte boundary, with the envelope and the commas counted', () => {
    // About 105 operations whose sizes add up to exactly `total` bytes, counting `comma` more per operation, for
    // totals at the edges of what a batch may hold. Each batch, written with the longest sequence number, must fit.
    // No room kept for the envelope, or no comma counted per operation, makes one of these sets a single batch one
    // message over (review of day 3: no test pinned either).
    const sized = (total: number, comma: number): string[] => {
      const texts: string[] = [];
      let bytes = 0;
      for (let i = 0; bytes < total; i++) {
        const counter = 1_000_000 + i * 10_000;
        const base = utf8Length(encodeOp(ins(counter, 'x'))) - 1 + comma;
        const length = Math.min(10_000, total - bytes - base);
        assert.ok(length >= 1, 'the sizes chosen leave room for one more operation');
        const text = encodeOp(ins(counter, 'x'.repeat(length)));
        texts.push(text);
        bytes += utf8Length(text) + comma;
      }
      assert.equal(bytes, total);
      return texts;
    };
    const limit = MAX_MESSAGE_BYTES - 64;
    for (const [total, comma] of [
      [limit, 1], // exactly the limit: one batch, 18 bytes under 1 MiB
      [MAX_MESSAGE_BYTES - 10, 1], // in one batch only if no room were kept for the envelope
      [limit, 0], // in one batch only if the commas weren't counted
      [MAX_MESSAGE_BYTES, 1],
    ] as const) {
      const batches = batchOps(sized(total, comma));
      if (total === limit && comma === 1) assert.equal(batches.length, 1);
      for (const batch of batches) {
        const message = encodeServerOps(Number.MAX_SAFE_INTEGER - batch.length + 1, batch);
        assert.ok(
          utf8Length(message) <= MAX_MESSAGE_BYTES,
          `${utf8Length(message)} bytes (total ${total}, comma ${comma})`,
        );
      }
    }
  });

  test('the largest operations each fit a message on their own', () => {
    const spans = Array.from({ length: 1_000 }, (_, i) => ({
      replica: 'r'.repeat(32),
      counter: Number.MAX_SAFE_INTEGER - 10_000 * (i + 1),
      length: 10_000,
    }));
    const big = encodeOp({ type: 'delete', spans });
    assert.ok(utf8Length(big) < 100_000, `${utf8Length(big)} bytes`);
    const batches = batchOps(Array<string>(30).fill(big));
    assert.ok(batches.every((b) => b.length >= 1));
    for (const batch of batches) {
      assert.ok(
        utf8Length(encodeServerOps(Number.MAX_SAFE_INTEGER - batch.length + 1, batch)) <=
          MAX_MESSAGE_BYTES,
      );
    }
  });
});

describe('batchEnd', () => {
  test("is where batchOps' batches end, from any start", () => {
    const texts = Array.from({ length: 300 }, (_, i) =>
      encodeOp(ins(i * 10_000 + 1, 'y'.repeat(((i * 7919) % 10_000) + 1))),
    );
    texts.push(...Array.from({ length: 1_500 }, (_, i) => encodeOp(ins(4_000_000 + i, 'z'))));
    let start = 0;
    for (const batch of batchOps(texts)) {
      assert.equal(batchEnd(texts, start), start + batch.length);
      start += batch.length;
    }
    assert.equal(batchEnd(texts, texts.length), texts.length);
  });
});

describe('utf8Length', () => {
  test("agrees with Node's encoder, lone surrogates included", () => {
    const unit = fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c));
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit }), fc.string({ unit: 'binary' })), (s) => {
        assert.equal(utf8Length(s), Buffer.byteLength(s, 'utf8'));
      }),
      { numRuns: 2_000 },
    );
  });

  test('at the boundaries of each length', () => {
    for (const s of [
      '',
      '\u007f',
      '\u0080',
      '߿',
      'ࠀ',
      '￿',
      '\u{10000}',
      '\u{10ffff}',
      '\ud800',
      '\udc00',
      '\udc00\ud800',
    ]) {
      assert.equal(utf8Length(s), Buffer.byteLength(s, 'utf8'), JSON.stringify(s));
    }
  });
});
