// Release review (d5) of 4db58f8: the re-anchoring's fallback walks back over every element whose COUNTER is not
// smaller than the insert's, but RGA's scan passes only LARGER IDS (counter, then replica). An element with the
// insert's own counter and a smaller replica is walked over, yet the scan from the new origin stops at it, so the
// insert lands before it: before visible text a never-collecting server puts it after. Equal counters across
// replicas are the common case (two replicas typing from the same state make the same counters).
//
// History: x types "p" (1@x). me types "c" after p (2@me): entry 2. y, having seen p, types "s" after p (2@y, larger
// than 2@me, so before c). b, having seen p and s, types "e" after s (3@b). x deletes c: entry 5; the server collects
// c (a leaf tombstone). me applied entries 1-2 and, offline, typed "X" after c (3@me, the same counter as e).
// Never collecting, everyone shows "pseX" (X after c, which is after s's subtree "se"). With collection, me finds c's
// place after e, X's place after e, and since e's counter (3) is not smaller than X's (3) walks back to s and sends
// X after s; the scan from s stops at e (3@b < 3@me), so X lands before e: everyone shows "psXe".
//
// Fixed (day 5): from the first unsent insert whose origin was collected, every unsent insert is re-issued under a
// new id right after the element before it in the never-collecting order (sync.ts placeUnsent); reissue.test.ts has
// the release review's fuzzer as a property.
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

test('a re-anchored insert is not put before a concurrent element with its own counter and a smaller replica', () => {
  const log: Op[] = [
    insert(1, 'x', null, 'p'),
    insert(2, 'me', [1, 'x'], 'c'),
    insert(2, 'y', [1, 'x'], 's'),
    insert(3, 'b', [2, 'y'], 'e'),
    { type: 'delete', spans: [{ replica: 'me', counter: 2, length: 1 }] },
  ];
  const server = new Rga('server');
  log.forEach((op, i) => server.apply(op, i + 1));
  assert.equal(server.collect(5), 1, 'c is a leaf tombstone, collected');

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
  client.edit(2, 0, 'X'); // "pcX": X after c, made offline
  const offlineInsert = insert(3, 'me', [2, 'me'], 'X');
  assert.deepEqual(
    client.rga.originOf({ replica: 'me', counter: 3 }),
    { replica: 'me', counter: 2 },
    'X is 3@me after c',
  );

  const never = new Rga('never');
  for (const op of log) never.apply(op);
  never.apply(offlineInsert);
  assert.equal(never.text(), 'pseX');

  client.start();
  latest().open();
  latest().take();
  latest().receive({ type: 'welcome', protocol: 1, doc: 'd', seq: 5 });
  latest().receive({ type: 'collected', spans: server.collectedSpans() });
  latest().receive({ type: 'snapshot', seq: 5, ops: server.snapshot(), last: true });
  assert.equal(client.status, 'online');
  const sent = latest()
    .take()
    .flatMap((m) => (m.type === 'ops' ? m.ops : []));
  for (const op of sent) server.apply(op, 6);
  assert.equal(server.text(), client.rga.text(), 'converged');
  assert.equal(
    client.rga.text(),
    never.text(),
    `the never-collecting server shows ${JSON.stringify(never.text())}; sent ${JSON.stringify(sent)}`,
  );
});
