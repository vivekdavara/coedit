// How long an edit takes to come back as an acknowledgement and to reach the other clients, over loopback.
//
//   npm run sync-latency -w @coedit/client -- [readers] [edits] [interval-ms]
//
// Starts the sync server as its own process (so it doesn't share an event loop with the clients), joins one writer
// and `readers` readers (default 3) to a fresh document, and has the writer type `edits` characters (default 2,000)
// at the end of the text, one every `interval-ms` (default 5 ms, 200 a second: faster than anyone types), paced by
// the clock rather than by the replies, so a slow reply doesn't slow the next edit. The first 200 edits are a
// warm-up and not counted. For each counted edit it records the time from edit() to its echo leaving the outbox
// (ack) and to each reader's replica reporting it (remote). Percentiles are nearest-rank. It also reports whether
// the machine slept during the run (performance.now() stops in sleep on macOS, Date.now() doesn't), and refuses
// to print numbers if it did.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyncClient } from '../src/sync.ts';

const [readers = 3, edits = 2_000, interval = 5] = process.argv.slice(2).map(Number);
const WARMUP = 200;
if (![readers, edits, interval].every((n) => Number.isFinite(n) && n >= 0) || edits <= WARMUP) {
  console.error(`usage: sync_latency.ts [readers] [edits > ${WARMUP}] [interval-ms]`);
  process.exit(2);
}

const MAIN = fileURLToPath(new URL('../../server/src/main.ts', import.meta.url));
// Documents in a new directory, removed at the end: each run starts from an empty document.
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-latency-'));
process.on('exit', () => {
  fs.rmSync(data, { recursive: true, force: true });
});
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN], {
  env: { PATH: process.env['PATH'] ?? '', COEDIT_PORT: '0', COEDIT_DATA: data },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const address = await new Promise<string>((resolve, reject) => {
  let out = '';
  server.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    out += chunk;
    const match = /listening on http:\/\/(\S+)/.exec(out);
    if (match?.[1] !== undefined) resolve(match[1]);
  });
  server.once('exit', (code) => {
    reject(new Error(`the server exited (${code}) before listening`));
  });
});

const url = `ws://${address}/sync`;
const doc = `latency-${Date.now()}`;
const sent: number[] = [];
const acked: number[] = [];
const writer = new SyncClient(
  { url, doc },
  {
    onProgress: () => {
      const done = sent.length - writer.unacknowledged;
      const now = performance.now();
      while (acked.length < done) acked.push(now);
    },
  },
);
const arrived: number[][] = [];
const clients = [writer];
for (let r = 0; r < readers; r++) {
  const times: number[] = [];
  arrived.push(times);
  const reader = new SyncClient(
    { url, doc },
    {
      onChanges: (changes) => {
        const now = performance.now();
        // One insert per edit, in the writer's order.
        for (const change of changes) if (change.type === 'insert') times.push(now);
      },
    },
  );
  clients.push(reader);
}
for (const c of clients) c.start();
const deadline = Date.now() + 10_000;
while (!clients.every((c) => c.status === 'online')) {
  if (Date.now() > deadline) throw new Error('clients not online within 10 s');
  await new Promise((resolve) => setTimeout(resolve, 5));
}

const wall0 = Date.now();
const mono0 = performance.now();
const start = performance.now();
for (let i = 0; i < edits; i++) {
  // Paced: edit i is due at start + i * interval, whatever happened to the ones before.
  const wait = start + i * interval - performance.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  sent.push(performance.now());
  writer.edit(writer.rga.length, 0, 'x');
}
const done = () => acked.length === edits && arrived.every((t) => t.length === edits);
while (!done()) {
  if (performance.now() - start > edits * interval + 30_000)
    throw new Error('not every edit arrived');
  await new Promise((resolve) => setTimeout(resolve, 5));
}
const slept = Date.now() - wall0 - (performance.now() - mono0);

for (const c of clients) c.stop();
server.kill('SIGTERM');

function percentiles(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number) =>
    sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] as number;
  const ms = (v: number) => v.toFixed(2);
  return `p50 ${ms(rank(50))}  p95 ${ms(rank(95))}  p99 ${ms(rank(99))}  max ${ms(rank(100))} ms  (n ${sorted.length})`;
}

const ack: number[] = [];
const remote: number[] = [];
for (let i = WARMUP; i < edits; i++) {
  ack.push((acked[i] as number) - (sent[i] as number));
  for (const times of arrived) remote.push((times[i] as number) - (sent[i] as number));
}
console.log(
  `node ${process.version}, 1 writer + ${readers} readers, ${edits} edits (${WARMUP} warm-up) one every ${interval} ms`,
);
console.log(
  `slept during the run: ${Math.max(0, slept).toFixed(0)} ms (wall clock minus monotonic)`,
);
if (slept > 50) {
  console.error('the machine slept during the run: these numbers are not latencies');
  process.exit(1);
}
console.log(`ack    ${percentiles(ack)}`);
console.log(`remote ${percentiles(remote)}`);
