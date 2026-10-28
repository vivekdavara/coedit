// What the strict wire format costs: decoding with the strict JSON reader plus every check, against plain
// JSON.parse, for three messages a client sends: one keystroke, a paste near the 1 MiB message limit, and a large
// delete. Synthetic messages; prints the median of several timed rounds after an untimed warm-up.
// Run: npm run bench-codec -w @coedit/crdt -- [rounds]
import { performance } from 'node:perf_hooks';
import { parseJson } from '../src/json.ts';
import {
  decodeClientMessage,
  encodeClientMessage,
  type ClientMessage,
  type Op,
} from '../src/protocol.ts';

const rounds = Number(process.argv[2] ?? 9);

const replica = 'Xq3vT0b9QmKk1Zr8w2LpAg'; // 22 characters: a base64url-encoded 16-byte id
const keystroke: ClientMessage = {
  type: 'ops',
  ops: [
    {
      type: 'insert',
      id: { replica, counter: 1042 },
      origin: { replica, counter: 1041 },
      text: 'e',
    },
  ],
};

// 100 inserts of 10,000 code points: one pasted megabyte, cut at the per-insert limit. Mixed text with some
// two-unit characters, so the code-point count isn't trivially the length.
const line = 'The quick brown fox jumps over the lazy dog. Ünïcödé and emoji 😀 too.\n';
const chunk = Array.from(line.repeat(200)).slice(0, 10_000).join('');
const pasteOps: Op[] = Array.from({ length: 100 }, (_, i) => ({
  type: 'insert',
  id: { replica, counter: 1 + i * 10_000 },
  origin: i === 0 ? null : { replica, counter: i * 10_000 },
  text: chunk,
}));
const paste: ClientMessage = { type: 'ops', ops: pasteOps };

// A delete of 1,000 spans, as after selecting a long stretch typed by many people in short runs.
const bigDelete: ClientMessage = {
  type: 'ops',
  ops: [
    {
      type: 'delete',
      spans: Array.from({ length: 1_000 }, (_, i) => ({
        replica: `${replica.slice(0, 20)}${String(i % 50).padStart(2, '0')}`,
        counter: 1 + i * 7,
        length: 1 + (i % 9),
      })),
    },
  ],
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Times `fn` over enough iterations to take ~50 ms per round; returns the median time per call in µs. */
function time(fn: () => unknown): number {
  let iterations = 1;
  for (;;) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    if (performance.now() - start > 50) break;
    iterations *= 2;
  }
  const perCall: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    perCall.push(((performance.now() - start) * 1000) / iterations);
  }
  return median(perCall);
}

console.log(`node ${process.version}, ${rounds} rounds, median per call`);
for (const [name, message] of [
  ['keystroke', keystroke],
  ['paste', paste],
  ['delete', bigDelete],
] as const) {
  const text = encodeClientMessage(message);
  const bytes = Buffer.byteLength(text);
  const plain = time(() => JSON.parse(text));
  const reader = time(() => parseJson(text));
  const decode = time(() => decodeClientMessage(text));
  const encode = time(() => encodeClientMessage(message));
  const mbps = (us: number) => (bytes / us).toFixed(0); // bytes per µs = MB/s
  console.log(
    `${name.padEnd(9)} ${String(bytes).padStart(9)} bytes: JSON.parse ${plain.toFixed(2)} µs (${mbps(plain)} MB/s), ` +
      `strict reader ${reader.toFixed(2)} µs (${mbps(reader)} MB/s, ${(reader / plain).toFixed(1)}x), ` +
      `decode ${decode.toFixed(2)} µs (${(decode / plain).toFixed(1)}x), encode ${encode.toFixed(2)} µs`,
  );
}
