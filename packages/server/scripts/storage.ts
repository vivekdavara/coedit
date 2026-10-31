// What keeping documents on disk costs (DESIGN.md "Persistence (day 4)"), measured on a hub with a store in a
// temporary directory (removed at the end).
//
//   npm run storage -w @coedit/server -- [messages] [entries]
//
// - Appends: `messages` messages (default 2,000) of one typed character each, submitted to a hub one after another,
//   in memory only, with a store without fsync, and with a store with fsync (the default: on macOS Node's fsync is
//   F_FULLFSYNC, which waits for the drive). Per message: the time submit() takes, which is when the hub would relay.
// - Loading: a document of `entries` log entries (default 100,000: one-character inserts, every fifth followed by a
//   backspace), opened by a new hub from its log alone, then from a snapshot written after the last entry. Also the
//   snapshot's write time and the bytes on disk.
//
// One process, nothing else of the server running. Percentiles are nearest-rank.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Rga } from '@coedit/crdt';
import { DocumentHub, type HubOptions, type Member } from '../src/hub.ts';

const [messages = 2_000, entries = 100_000] = process.argv.slice(2).map(Number);
if (![messages, entries].every((n) => Number.isSafeInteger(n) && n >= 10)) {
  console.error('usage: storage.ts [messages >= 10] [entries >= 10]');
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-storage-'));
process.on('exit', () => {
  fs.rmSync(root, { recursive: true, force: true });
});
const fmt = (n: number) => n.toLocaleString('en-US');
const member = (replica: string): Member => ({
  replica,
  send(_text, sent) {
    sent?.();
  },
  replace() {},
  fail(refusal) {
    throw new Error(`the hub failed: ${refusal.message}`);
  },
});
const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
let docs = 0;

function appends(what: string, options: HubOptions): void {
  const hub = new DocumentHub(`append-${++docs}`, options);
  const m = member('a');
  hub.join(m, 0);
  const rga = new Rga('a');
  const times: number[] = [];
  const start = performance.now();
  for (let i = 0; i < messages; i++) {
    const ops = rga.edit(rga.length, 0, 'x');
    const t = performance.now();
    const refusal = hub.submit(m, ops);
    times.push(performance.now() - t);
    if (refusal !== null) throw new Error(refusal.message);
  }
  const total = performance.now() - start;
  hub.close();
  if (hub.seq !== messages) throw new Error(`logged ${hub.seq} of ${messages}`);
  times.sort((a, b) => a - b);
  console.log(
    `  ${what}: ${fmt(Math.round((messages / total) * 1000))} messages/s; submit p50 ${pct(times, 50).toFixed(3)} ms, p99 ${pct(times, 99).toFixed(3)} ms, max ${(times.at(-1) as number).toFixed(3)} ms`,
  );
}

console.log(`appends: ${fmt(messages)} messages of one insert each`);
appends('in memory only', {});
appends('store, no fsync', {
  store: { root, fsync: false },
  snapshotEvery: Number.MAX_SAFE_INTEGER,
});
appends('store, fsync each message', { store: { root }, snapshotEvery: Number.MAX_SAFE_INTEGER });

// A document of `entries` entries, written without fsync (only its reading back is measured).
const doc = 'load';
{
  const hub = new DocumentHub(doc, {
    store: { root, fsync: false },
    snapshotEvery: Number.MAX_SAFE_INTEGER,
  });
  const m = member('w');
  hub.join(m, 0);
  const rga = new Rga('w');
  while (hub.seq < entries) {
    const ops = hub.seq % 6 === 5 ? rga.edit(rga.length - 1, 1, '') : rga.edit(rga.length, 0, 'y');
    hub.submit(m, ops);
  }
  hub.close();
}
const bytes = (dir: string) =>
  fs.readdirSync(dir).reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
const dir = path.join(root, doc);
console.log(`loading a document of ${fmt(entries)} log entries (${fmt(bytes(dir))} bytes of log):`);
let start = performance.now();
const fromLog = new DocumentHub(doc, { store: { root, fsync: false } });
const logMs = performance.now() - start;
console.log(
  `  from the log alone: ${fmt(Math.round(logMs))} ms (${fmt(fromLog.text().length)} visible characters)`,
);

// A snapshot after the last entry: one more message, with the snapshot interval reached.
const writer = member('s');
const hubForSnapshot = new DocumentHub(doc, { store: { root, fsync: true }, snapshotEvery: 1 });
fromLog.close();
hubForSnapshot.join(writer, hubForSnapshot.seq);
const extra = new Rga('s');
start = performance.now();
hubForSnapshot.submit(writer, extra.edit(0, 0, 'z'));
const snapshotMs = performance.now() - start;
// One more: its snapshot drops the log from before the first, as a document that has been running a while has.
hubForSnapshot.submit(writer, extra.edit(1, 0, 'z'));
hubForSnapshot.close();
const snapshotFile = fs.readdirSync(dir).find((n) => n.startsWith('snapshot-')) as string;
console.log(
  `  writing a snapshot of it (with fsync, inside the submit that reached the interval): ${fmt(Math.round(snapshotMs))} ms, ${fmt(fs.statSync(path.join(dir, snapshotFile)).size)} bytes`,
);
start = performance.now();
const fromSnapshot = new DocumentHub(doc, { store: { root, fsync: false } });
const snapMs = performance.now() - start;
console.log(
  `  from the snapshot: ${fmt(Math.round(snapMs))} ms (${fmt(fromSnapshot.text().length)} visible characters; it also reads the ${fmt(fromSnapshot.seq - fromSnapshot.base)} entries kept since the previous snapshot)`,
);
fromSnapshot.close();
