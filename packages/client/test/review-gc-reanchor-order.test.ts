// Review of the tombstone collection (2a26ec5): the client's re-anchoring moves an offline insert past VISIBLE text.
//
// What's wrong: #rebuild re-anchors an unsent insert whose origin was collected "after the nearest element before
// it, in the old replica's sequence, that the new one holds with a smaller counter". The old sequence is only what
// this client had seen; the snapshot can hold concurrent elements the client never saw, placed between that element
// and where the collected origin was. With the new origin the insert scans from there and stops at the first smaller
// id, so it lands BEFORE such a concurrent element instead of after it. A server that never collected would have put
// it after the collected origin, i.e. after that concurrent text. The comment and DESIGN.md "Tombstones" promise only
// that "its place next to deleted text may move"; here it moves past visible text someone else typed (the same
// mechanism moves it before a whole concurrent paragraph).
//
// History: x types "p" (1@x) then "t" (2@x, after p): entries 1-2. Client `me` applies them, goes offline, and types
// "X" after t (3@me, origin 2@x). Meanwhile y, which had only seen p, typed "Y" after p (2@y): entry 3; RGA puts it
// between p and t (2@y > 2@x). x then backspaces t: entry 4, and the server collects t (a leaf).
// Never collecting, every replica ends with "pYX". With collection, me re-anchors X after p and everyone ends with
// "pXY".
//
// Right behaviour: the re-anchored insert lands where the never-collecting system puts it ("pYX"), or at least never
// crosses visible text that wasn't next to the deleted text in the sender's view.
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

test('a re-anchored offline insert lands where a never-collecting server puts it, not before concurrent text', () => {
  const log: Op[] = [
    insert(1, 'x', null, 'p'),
    insert(2, 'x', [1, 'x'], 't'),
    insert(2, 'y', [1, 'x'], 'Y'), // y saw only p
    { type: 'delete', spans: [{ replica: 'x', counter: 2, length: 1 }] }, // x backspaces t
  ];
  // The collecting server's replica (each op stamped with its entry), collecting what the snapshot lets go of.
  const server = new Rga('server');
  log.forEach((op, i) => server.apply(op, i + 1));
  assert.equal(server.collect(4), 1, 't is a leaf tombstone, collected');

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
  client.edit(2, 0, 'X'); // "ptX": 3@me after t, made offline
  const offlineInsert = insert(3, 'me', [2, 'x'], 'X');

  // A server that never collects: the same log, then me's insert as made.
  const never = new Rga('never');
  for (const op of log) never.apply(op);
  never.apply(offlineInsert);
  assert.equal(never.text(), 'pYX');

  // me comes back to the collecting server: the collected ids, then the snapshot.
  client.start();
  latest().open();
  latest().take();
  latest().receive({ type: 'welcome', protocol: 1, doc: 'd', seq: 4 });
  latest().receive({ type: 'collected', spans: server.collectedSpans() });
  latest().receive({ type: 'snapshot', seq: 4, ops: server.snapshot(), last: true });
  assert.equal(client.status, 'online');
  const sent = latest()
    .take()
    .flatMap((m) => (m.type === 'ops' ? m.ops : []));
  for (const op of sent) server.apply(op, 5);
  assert.equal(server.text(), client.rga.text(), 'converged');
  // Fails on 2a26ec5: sent is 3@me after 1@x (p), and everyone shows "pXY": X crossed y's visible "Y".
  assert.equal(client.rga.text(), never.text(), `sent ${JSON.stringify(sent)}`);
});
