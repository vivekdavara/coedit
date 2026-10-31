// How fast the CRDT is, and how big a document gets, over a synthetic editing session (DESIGN.md "Persistence and
// tombstones (day 4)": measured).
//
//   npm run editing -w @coedit/crdt -- [edits] [seed]
//
// One writer makes `edits` edits (default 100,000) from a seeded random model of someone typing: 70% type one
// character at the caret, 15% backspace, 5% move the caret anywhere, 4% delete a selection of 2-50 characters at the
// caret, 1% paste 20-500 characters, 5% type a word of 3-8 characters as one edit. It reports, all measured here:
//
// - local typing: Rga.edit's rate over each tenth of the session, with the document's size at its end (the
//   elements live in one array and positions are found by scanning, so this falls as the document grows);
// - remote integration: a second replica applying every operation, in order, as received objects and from their
//   JSON text (the strict decoder: what the sync client does);
// - a large paste: 100,000 characters into the middle of the final document, locally and remotely;
// - growth: visible characters, elements held (tombstones included), the tombstone share, the snapshot's and the
//   log's size in bytes per visible character, and the heap a replica rebuilt from the snapshot takes per element
//   (with --expose-gc, which `npm run editing` passes).
//
// The session is synthetic: the model's rates are guesses, not a recorded trace.
import { Rga } from '../src/rga.ts';
import { decodeServerMessage, encodeOp, utf8Length, type Op } from '../src/protocol.ts';

const [edits = 100_000, seed = 1] = process.argv.slice(2).map(Number);
if (!Number.isSafeInteger(edits) || edits < 10 || !Number.isSafeInteger(seed)) {
  console.error('usage: editing.ts [edits >= 10] [seed]');
  process.exit(2);
}

/** mulberry32: a small seeded generator, so a run can be repeated exactly. */
function random(s: number): () => number {
  let a = s >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = random(seed);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const letters = 'etaoinshrdlucmfwypvbgkjqxz      ';
const text = (n: number) => {
  let s = '';
  for (let i = 0; i < n; i++) s += letters.charAt(int(0, letters.length - 1));
  return s;
};

const writer = new Rga('writer');
const log: Op[] = [];
let caret = 0;
const tenth = Math.ceil(edits / 10);
const windows: { edits: number; ms: number; length: number; elements: number }[] = [];
const kinds = { type: 0, backspace: 0, move: 0, selection: 0, paste: 0, word: 0 };
let windowStart = performance.now();
let windowEdits = 0;
for (let i = 0; i < edits; i++) {
  const r = rand();
  let ops: Op[];
  if (r < 0.7) {
    ops = writer.edit(caret, 0, text(1));
    caret += 1;
    kinds.type++;
  } else if (r < 0.85 && caret > 0) {
    ops = writer.edit(caret - 1, 1, '');
    caret -= 1;
    kinds.backspace++;
  } else if (r < 0.9) {
    caret = int(0, writer.length);
    ops = [];
    kinds.move++;
  } else if (r < 0.94 && caret < writer.length) {
    ops = writer.edit(caret, Math.min(int(2, 50), writer.length - caret), '');
    kinds.selection++;
  } else if (r < 0.95) {
    const pasted = text(int(20, 500));
    ops = writer.edit(caret, 0, pasted);
    caret += pasted.length;
    kinds.paste++;
  } else {
    const word = text(int(3, 8));
    ops = writer.edit(caret, 0, word);
    caret += word.length;
    kinds.word++;
  }
  for (const op of ops) log.push(op);
  windowEdits++;
  if ((i + 1) % tenth === 0 || i + 1 === edits) {
    const now = performance.now();
    windows.push({
      edits: windowEdits,
      ms: now - windowStart,
      length: writer.length,
      elements: writer.sizes().elements,
    });
    windowStart = now;
    windowEdits = 0;
  }
}

const rate = (n: number, ms: number) => Math.round((n / ms) * 1000).toLocaleString('en-US');
const fmt = (n: number) => n.toLocaleString('en-US');
console.log(`synthetic session: ${fmt(edits)} edits (seed ${seed}), ${fmt(log.length)} operations`);
console.log(
  `  kinds: ${Object.entries(kinds)
    .map(([k, n]) => `${k} ${fmt(n)}`)
    .join(', ')}`,
);
console.log('local typing (Rga.edit), each tenth of the session:');
for (const [i, w] of windows.entries()) {
  console.log(
    `  ${String(i + 1).padStart(2)}: ${rate(w.edits, w.ms)} edits/s, ending at ${fmt(w.length)} visible / ${fmt(w.elements)} elements`,
  );
}

// Remote integration: as objects, then from text through the strict decoder.
const texts = log.map(encodeOp);
const reader = new Rga('reader');
let start = performance.now();
for (const op of log) reader.apply(op);
const applyMs = performance.now() - start;
if (reader.state() !== writer.state()) throw new Error('the reader did not converge');
const decoded = new Rga('decoder');
start = performance.now();
for (let i = 0; i < texts.length; i++) {
  const message = decodeServerMessage(`{"type":"ops","from":${i + 1},"ops":[${texts[i]}]}`);
  if (message.type !== 'ops') throw new Error('not an ops message');
  for (const op of message.ops) decoded.apply(op);
}
const decodeMs = performance.now() - start;
if (decoded.state() !== writer.state()) throw new Error('the decoding reader did not converge');
console.log(
  `remote integration: ${rate(log.length, applyMs)} operations/s applied (${fmt(Math.round(applyMs))} ms), ${rate(log.length, decodeMs)}/s from JSON text through the decoder (${fmt(Math.round(decodeMs))} ms)`,
);

// A large paste into the middle.
const paste = text(100_000);
const middle = Math.floor(writer.length / 2);
start = performance.now();
const pasteOps = writer.edit(middle, 0, paste);
const pasteLocal = performance.now() - start;
start = performance.now();
for (const op of pasteOps) reader.apply(op);
const pasteRemote = performance.now() - start;
if (reader.text() !== writer.text()) throw new Error('the paste did not converge');
console.log(
  `large paste: ${fmt(paste.length)} characters (${pasteOps.length} operations) at ${fmt(middle)}: ${pasteLocal.toFixed(1)} ms local, ${pasteRemote.toFixed(1)} ms remote`,
);
// Back to the session's end state for the growth numbers.
for (const op of writer.edit(middle, paste.length, '')) reader.apply(op);

// Growth, at the end of the session plus the paste and its deletion (the paste's 100,000 elements stay as tombstones).
const sizes = writer.sizes();
const visible = writer.length;
const snapshot = writer.snapshot().map(encodeOp);
const snapshotBytes = snapshot.reduce((sum, t) => sum + utf8Length(t) + 1, 0);
let logBytes = 0;
for (let i = 0; i < texts.length; i++) {
  logBytes += utf8Length(`{"seq":${i + 1},"op":${texts[i] as string}}\n`);
}
console.log(
  `growth (session, then the paste deleted again): ${fmt(visible)} visible characters, ${fmt(sizes.elements)} elements, ${((sizes.tombstones / sizes.elements) * 100).toFixed(1)}% tombstones`,
);
console.log(
  `  snapshot ${fmt(snapshotBytes)} bytes (${(snapshotBytes / visible).toFixed(1)} per visible character, ${snapshot.length} operations); session log ${fmt(logBytes)} bytes (${(logBytes / visible).toFixed(1)} per visible character)`,
);
const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) {
  console.log('  heap: run with --expose-gc to measure');
} else {
  // Three copies kept alive at once, two collections either side: one copy's size is too close to what else a
  // single collection may or may not free (a first version measured one copy and reported a negative size).
  const ops = writer.snapshot();
  gc();
  gc();
  const before = process.memoryUsage().heapUsed;
  const copies = [0, 1, 2].map((i) => {
    const copy = new Rga(`heap${i}`);
    for (const op of ops) copy.apply(op);
    return copy;
  });
  gc();
  gc();
  const after = process.memoryUsage().heapUsed;
  const each = (after - before) / copies.length;
  const same = copies.every((c) => c.length === visible);
  console.log(
    `  heap: a replica rebuilt from the snapshot takes ${fmt(Math.round(each))} bytes, ${(each / sizes.elements).toFixed(0)} per element (mean of ${copies.length} kept at once; ${same ? 'same text' : 'TEXT DIFFERS'})`,
  );
}
