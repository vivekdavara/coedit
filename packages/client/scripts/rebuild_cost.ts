// What a client's rebuild from a snapshot costs, with and without re-issuing an unsent insert (day 5).
//
//   npm run rebuild-cost -w @coedit/client -- [characters] [runs]
//
// x types `characters` characters (default 100,000) one at a time; the client applies them, goes offline and types
// one character after x's last. Then x deletes either that last character, which the server collects (so the
// client's insert names a collected element and is re-issued, which builds a scratch replica of the whole snapshot),
// or its first, which nothing collects (no re-issue). The client rejoins and gets the snapshot in parts of 1,000
// operations; the time is from the first part to the client being online, its outbox gone over. Each case runs
// `runs` times (default 3), alternating. Everything is in one process, without sockets: this measures the client's
// work, not the network.
import {
  Rga,
  decodeClientMessage,
  encodeServerMessage,
  type ClientMessage,
  type Op,
  type ServerMessage,
} from '@coedit/crdt';
import { SyncClient, type SocketLike } from '../src/sync.ts';

const [characters = 100_000, runs = 3] = process.argv.slice(2).map(Number);
if (![characters, runs].every((n) => Number.isSafeInteger(n) && n >= 2)) {
  console.error('usage: rebuild_cost.ts [characters >= 2] [runs >= 2]');
  process.exit(2);
}

class Socket implements SocketLike {
  readyState = 0;
  readonly sent: ClientMessage[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(decodeClientMessage(data));
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: ServerMessage): void {
    this.onmessage?.({ data: encodeServerMessage(message) });
  }
}

function run(reissue: boolean): { ms: number; parts: number; collected: number; sent: Op[] } {
  const x = new Rga('x');
  const log: Op[] = [];
  for (let i = 0; i < characters; i++)
    log.push(...x.edit(i, 0, String.fromCharCode(97 + (i % 26))));
  const sockets: Socket[] = [];
  const client = new SyncClient({
    url: 'ws://local/sync',
    doc: 'cost',
    replica: 'me',
    connect: () => {
      const s = new Socket();
      sockets.push(s);
      return s;
    },
  });
  const latest = () => sockets.at(-1) as Socket;
  client.start();
  latest().open();
  latest().receive({ type: 'welcome', protocol: 1, doc: 'cost', seq: log.length });
  for (let i = 0; i < log.length; i += 1000) {
    latest().receive({ type: 'ops', from: i + 1, ops: log.slice(i, i + 1000) });
  }
  client.stop();
  client.edit(characters, 0, 'Z');
  log.push(...x.edit(reissue ? characters - 1 : 0, 1, ''));
  const server = new Rga('server');
  log.forEach((op, i) => server.apply(op, i + 1));
  const collected = server.collect(log.length);
  const ops = server.snapshot();
  client.start();
  latest().open();
  latest().receive({ type: 'welcome', protocol: 1, doc: 'cost', seq: log.length });
  if (collected > 0) latest().receive({ type: 'collected', spans: server.collectedSpans() });
  const parts = Math.ceil(ops.length / 1000);
  const t0 = performance.now();
  for (let p = 0; p < parts; p++) {
    const part = ops.slice(p * 1000, (p + 1) * 1000);
    latest().receive({ type: 'snapshot', seq: log.length, ops: part, last: p === parts - 1 });
  }
  const ms = performance.now() - t0;
  if (client.status !== 'online')
    throw new Error(`the client is ${client.status}: ${client.detail}`);
  const sent = latest().sent.flatMap((m) => (m.type === 'ops' ? m.ops : []));
  client.stop();
  return { ms, parts, collected, sent };
}

console.log(
  `a document of ${characters.toLocaleString('en-US')} characters, ${runs} runs of each case`,
);
const times = { plain: [] as number[], reissue: [] as number[] };
for (let i = 0; i < runs; i++) {
  for (const reissue of [false, true]) {
    const { ms, parts, collected, sent } = run(reissue);
    const insert = sent.find((op) => op.type === 'insert');
    if (insert?.type !== 'insert') throw new Error('the unsent insert was not sent');
    const renamed = reissue ? `re-issued as ${insert.id.counter}@me` : 'sent as it was';
    if (i === 0) {
      console.log(
        `  ${reissue ? 're-issue' : 'no re-issue'}: ${collected} collected, ${parts} snapshot parts, the insert ${renamed}`,
      );
    }
    (reissue ? times.reissue : times.plain).push(ms);
  }
}
const list = (ms: number[]) => ms.map((m) => m.toFixed(1)).join(', ');
console.log(`rebuild without re-issuing: ${list(times.plain)} ms`);
console.log(`rebuild with re-issuing:    ${list(times.reissue)} ms`);
