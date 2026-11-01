// Release review (d5) of 4db58f8: two unsent inserts after the same collected element come back in the wrong order,
// so this client's own text is reordered.
//
// #rebuild re-anchors each insert in turn, finding where its collected origin t "would be" by scanning from t's own
// origin past every larger id. For the second insert that scan passes the first one, already re-anchored into the new
// replica as an ordinary element (its id is larger than t's), so t is taken to sit AFTER the first insert and the
// second insert goes after it too. Under RGA both are children of t, the larger id (the later one typed) first.
//
// History: x types "p" (1@x) and "t" (2@x after p). me applies both and, offline, types "X" after t (3@me): "ptX";
// then puts the caret back after t and types "Y" (4@me, after t): "ptYX". x deletes t; the server collects it.
// Never collecting, everyone shows "pYX", as me did. With collection, me shows (and sends) "pXY".
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

test('two unsent inserts after one collected element keep the order the sender typed them in', () => {
  const log: Op[] = [
    insert(1, 'x', null, 'p'),
    insert(2, 'x', [1, 'x'], 't'),
    { type: 'delete', spans: [{ replica: 'x', counter: 2, length: 1 }] },
  ];
  const server = new Rga('server');
  log.forEach((op, i) => server.apply(op, i + 1));
  assert.equal(server.collect(3), 1, 't is a leaf tombstone, collected');

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
  client.edit(2, 0, 'X'); // "ptX"
  client.edit(2, 0, 'Y'); // "ptYX": 4@me after t too
  assert.equal(client.rga.text(), 'ptYX');

  const never = new Rga('never');
  for (const op of log) never.apply(op);
  never.apply(insert(3, 'me', [2, 'x'], 'X'));
  never.apply(insert(4, 'me', [2, 'x'], 'Y'));
  assert.equal(never.text(), 'pYX');

  client.start();
  latest().open();
  latest().take();
  latest().receive({ type: 'welcome', protocol: 1, doc: 'd', seq: 3 });
  latest().receive({ type: 'collected', spans: server.collectedSpans() });
  latest().receive({ type: 'snapshot', seq: 3, ops: server.snapshot(), last: true });
  assert.equal(client.status, 'online');
  const sent = latest()
    .take()
    .flatMap((m) => (m.type === 'ops' ? m.ops : []));
  for (const op of sent) server.apply(op, 4);
  assert.equal(server.text(), client.rga.text(), 'converged');
  assert.equal(
    client.rga.text(),
    never.text(),
    `me typed "ptYX"; the never-collecting server shows ${JSON.stringify(never.text())}; sent ${JSON.stringify(sent)}`,
  );
});
