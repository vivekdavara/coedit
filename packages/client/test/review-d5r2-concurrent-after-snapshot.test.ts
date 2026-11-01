// Release review round 2 (d5r2) of 2847a8b: a re-issued insert jumps ahead of text another replica typed at the same
// place and that was logged after the snapshot's entry, so the document ends differently from a never-collecting
// server, which the commit and #rebuild's comment claim it reproduces ("The text, and its place among the text that
// remains, are what they would have been without collection").
//
// The re-issued id is larger than every id the client knows, so the insert lands right after its new origin, ahead of
// every sibling of that origin, including concurrent ones that reach the client only in the catch-up after the
// snapshot (anything logged while a large snapshot is being streamed). A never-collecting server orders those by the
// tree: the insert sits in the collected element's subtree, and a sibling with a larger id than that element comes
// before the whole subtree. reissue.test.ts never logs anything after the snapshot's seq, so its property can't see it.
//
// History: x types "p" (1@x) and "c" (2@x after p). me applies both and, offline, types "X" after c (3@me): "pcX".
// x deletes c (entry 3); the server collects it and me joins with a snapshot after entry 3. Meanwhile y, which has
// seen p and c, types "Y" after p (3@y), logged as entry 4, after the snapshot. Never collecting: p's children are
// Y (3@y) and c (2@x), larger first, so "p Y c X" shows "pYX". Collecting: X is re-issued as 4@me after p, larger
// than 3@y, so everyone shows "pXY". Convergent, but not the never-collecting text.
//
// Since the round's other fix (re-issued counters go on from the snapshot's highest, not the client's clock), X is
// 2@me, which sorts after 3@y, and this history comes out as never collecting. That isn't so in general: text logged
// after the snapshot whose id falls between the collected element's and the re-issued one's still lands on the other
// side. The claim is narrowed instead (sync.ts #rebuild, DESIGN.md "Tombstones", the README's limitations), and
// reissue.test.ts's third property counts it: converging always, a different order in 55 of 1,000 sessions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Rga,
  decodeClientMessage,
  encodeServerMessage,
  type ClientMessage,
  type InsertOp,
  type Op,
  type ServerMessage,
} from '@coedit/crdt';
import { SyncClient, type SocketLike } from '../src/sync.ts';

class FakeSocket implements SocketLike {
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
  take(): ClientMessage[] {
    return this.sent.splice(0);
  }
}

const insert = (
  counter: number,
  replica: string,
  origin: [number, string] | null,
  text: string,
): InsertOp => ({
  type: 'insert',
  id: { replica, counter },
  origin: origin === null ? null : { counter: origin[0], replica: origin[1] },
  text,
});

test('a re-issued insert keeps the never-collecting order against text logged after the snapshot', () => {
  const log: Op[] = [
    insert(1, 'x', null, 'p'),
    insert(2, 'x', [1, 'x'], 'c'),
    { type: 'delete', spans: [{ replica: 'x', counter: 2, length: 1 }] },
  ];
  const server = new Rga('server');
  log.forEach((op, i) => server.apply(op, i + 1));
  assert.equal(server.collect(3), 1, 'c is a leaf tombstone, collected');
  const snapshot = server.snapshot();
  const collected = server.collectedSpans();
  // Logged after the snapshot's entry: y saw p and c, and typed after p.
  const y = insert(3, 'y', [1, 'x'], 'Y');
  server.apply(y, 4);

  const sockets: FakeSocket[] = [];
  const client = new SyncClient({
    url: 'ws://test/sync',
    doc: 'd',
    replica: 'me',
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    backoffMs: { initial: 1, max: 4 },
    random: () => 1,
  });
  const latest = () => sockets.at(-1) as FakeSocket;
  client.start();
  latest().open();
  latest().take();
  latest().receive({ type: 'welcome', protocol: 1, doc: 'd', seq: 2 });
  latest().receive({ type: 'ops', from: 1, ops: log.slice(0, 2) });
  client.stop();
  client.edit(2, 0, 'X'); // "pcX": 3@me after c
  assert.equal(client.rga.text(), 'pcX');

  const never = new Rga('never');
  for (const op of log) never.apply(op);
  never.apply(y);
  never.apply(insert(3, 'me', [2, 'x'], 'X'));

  client.start();
  latest().open();
  latest().take();
  latest().receive({ type: 'welcome', protocol: 1, doc: 'd', seq: 4 });
  latest().receive({ type: 'collected', spans: collected });
  latest().receive({ type: 'snapshot', seq: 3, ops: snapshot, last: true });
  latest().receive({ type: 'ops', from: 4, ops: [y] });
  assert.equal(client.status, 'online');
  const sent = latest()
    .take()
    .flatMap((m) => (m.type === 'ops' ? m.ops : []));
  for (const op of sent) server.apply(op, 5);
  assert.equal(server.text(), client.rga.text(), 'converged');
  assert.equal(
    client.rga.text(),
    never.text(),
    `the never-collecting server shows ${JSON.stringify(never.text())}; with collection everyone shows ` +
      `${JSON.stringify(client.rga.text())} (sent ${JSON.stringify(sent)})`,
  );
});
