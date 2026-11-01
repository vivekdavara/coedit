// Release review round 2 (d5r2) of 2847a8b: re-issuing an unsent insert spends a second run of counters on top of the
// abandoned one, and the server's counter check (hub.ts #check: an insert may end at most a capacity past the
// document's clock) then refuses it with `refused-op`, which the client takes as final (status `failed`). Without
// collection the same insert, under its own id, is accepted.
//
// The client's new replica keeps the old clock (so the abandoned ids, 3..27@me here, are never reused), and the
// re-issued ids start above it (28..52@me), while the server's clock is still where it was when the client went
// offline (2). An honest client's counters were meant to be "at most the server's clock plus the elements it made
// since, which its capacity bounds"; re-issuing makes that twice the elements. Small capacities here; at the default
// (2^23 - 1) it takes an unsent edit of more than about 4.2 million code points after a collected element, so this is
// hardening, but the bound the server's comment states no longer holds for an honest client.
//
// History (capacity 40 everywhere): x types "p" (1@x) and "c" (2@x after p). me applies both and, offline, pastes 25
// characters after c (3..27@me). x deletes c; the server collects it. me rebuilds from the snapshot and re-issues the
// paste as 28..52@me after p; the server's clock is 2, and 52 > 2 + 40.
//
// Fixed (day 5): re-issued counters go on from the highest counter the new replica holds or has collected of this
// client's (what the server's clock was at the snapshot), so they end at most the unsent text's length past it;
// they may reuse the abandoned ids' counters, which no one saw. Here the paste goes out as 2..26@me.
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
import { DocumentHub, type Member, type Refusal } from '../../server/src/hub.ts';
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

class FakeMember implements Member {
  readonly replica: string;
  constructor(replica: string) {
    this.replica = replica;
  }
  send(_text: string, sent?: () => void): void {
    sent?.();
  }
  replace(): void {}
  readonly failures: Refusal[] = [];
  fail(refusal: Refusal): void {
    this.failures.push(refusal);
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

test("a re-issued insert stays within the server's counter bound for an honest client", () => {
  const capacity = 40;
  const log: Op[] = [
    insert(1, 'x', null, 'p'),
    insert(2, 'x', [1, 'x'], 'c'),
    { type: 'delete', spans: [{ replica: 'x', counter: 2, length: 1 }] },
  ];
  const collecting = new Rga('server', { capacity });
  log.forEach((op, i) => collecting.apply(op, i + 1));
  assert.equal(collecting.collect(3), 1, 'c is a leaf tombstone, collected');

  const sockets: FakeSocket[] = [];
  const client = new SyncClient({
    url: 'ws://test/sync',
    doc: 'd',
    replica: 'me',
    capacity,
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
  client.edit(2, 0, 'abcdefghijklmnopqrstuvwxy'); // 25 code points, 3..27@me after c
  const original = client.rga.text();

  client.start();
  latest().open();
  latest().take();
  latest().receive({ type: 'welcome', protocol: 1, doc: 'd', seq: 3 });
  latest().receive({ type: 'collected', spans: collecting.collectedSpans() });
  latest().receive({ type: 'snapshot', seq: 3, ops: collecting.snapshot(), last: true });
  assert.equal(client.status, 'online');
  const sent = latest()
    .take()
    .flatMap((m) => (m.type === 'ops' ? m.ops : []));
  assert.equal(sent.length, 1, 'the paste, re-issued');

  // The hub's own check, on a hub holding the same document (its clock is 2: collection doesn't change it).
  const hub = new DocumentHub('d', { capacity });
  const x = new FakeMember('x');
  assert.equal(hub.join(x, 0), null);
  assert.equal(hub.submit(x, log), null);
  const me = new FakeMember('me');
  assert.equal(hub.join(me, 3), null);
  // Never collecting, the paste under its own id is accepted:
  const never = new DocumentHub('d', { capacity });
  const x2 = new FakeMember('x');
  never.join(x2, 0);
  never.submit(x2, log);
  const me2 = new FakeMember('me');
  never.join(me2, 3);
  assert.equal(never.submit(me2, [insert(3, 'me', [2, 'x'], 'abcdefghijklmnopqrstuvwxy')]), null);

  const refusal = hub.submit(me, sent);
  assert.equal(
    refusal,
    null,
    `the server refuses the re-issued paste ${JSON.stringify(sent[0])}: ${JSON.stringify(refusal)}; ` +
      `the client (text ${JSON.stringify(original)}) then fails for good`,
  );
});
