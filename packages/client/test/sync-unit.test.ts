// The sync client against a scripted socket (src/sync.ts): exactly what it sends, and what it does with each kind
// of message. sync.test.ts runs it against the real server.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeClientMessage,
  encodeServerMessage,
  type ClientMessage,
  type InsertOp,
  type Op,
  type ServerMessage,
} from '@coedit/crdt';
import {
  SyncClient,
  randomReplica,
  type Selection,
  type SocketLike,
  type Status,
} from '../src/sync.ts';

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: ClientMessage[] = [];
  closedWith: number | undefined;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string): void {
    assert.equal(this.readyState, 1, 'sent on a socket that is not open');
    this.sent.push(decodeClientMessage(data));
  }

  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(message: ServerMessage | string): void {
    this.onmessage?.({
      data: typeof message === 'string' ? message : encodeServerMessage(message),
    });
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }

  take(): ClientMessage[] {
    return this.sent.splice(0);
  }
}

/** A client whose sockets are FakeSockets (the latest in `sockets.at(-1)`) and whose retries are immediate. */
function setup(
  events: { statuses?: [Status, string][]; changes?: unknown[][]; onProgress?: () => void } = {},
) {
  const sockets: FakeSocket[] = [];
  const client = new SyncClient(
    {
      url: 'ws://test/sync',
      doc: 'd',
      replica: 'me',
      connect: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      backoffMs: { initial: 1, max: 4 },
      random: () => 1,
    },
    {
      onStatus: (status, detail) => events.statuses?.push([status, detail]),
      onChanges: (changes) => events.changes?.push([...changes]),
      onProgress: () => events.onProgress?.(),
    },
  );
  const latest = () => sockets.at(-1) as FakeSocket;
  return { client, sockets, latest };
}

const welcome = (seq: number): ServerMessage => ({ type: 'welcome', protocol: 1, doc: 'd', seq });
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
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('joining', () => {
  test('says hello with what it has applied, and goes online once caught up', () => {
    const statuses: [Status, string][] = [];
    const { client, latest } = setup({ statuses });
    client.start();
    assert.equal(client.status, 'connecting');
    latest().open();
    assert.deepEqual(latest().take(), [
      { type: 'hello', protocol: 1, doc: 'd', replica: 'me', have: 0 },
    ]);
    assert.equal(client.status, 'syncing');
    latest().receive(welcome(2));
    assert.equal(client.status, 'syncing', 'two entries to go');
    latest().receive({
      type: 'ops',
      from: 1,
      ops: [insert(1, 'x', null, 'a'), insert(2, 'x', [1, 'x'], 'b')],
    });
    assert.equal(client.status, 'online');
    assert.equal(client.seq, 2);
    assert.equal(client.rga.text(), 'ab');
    assert.deepEqual(
      statuses.map(([s]) => s),
      ['connecting', 'syncing', 'online'],
    );
  });

  test('an empty log: online at the welcome', () => {
    const { client, latest } = setup();
    client.start();
    latest().open();
    latest().receive(welcome(0));
    assert.equal(client.status, 'online');
  });
});

describe('the outbox', () => {
  test('holds edits made before joining and sends them once caught up, after the missed entries', () => {
    const { client, latest } = setup();
    client.start();
    client.edit(0, 0, 'hi');
    assert.equal(client.unacknowledged, 1);
    latest().open();
    latest().take();
    latest().receive(welcome(1));
    assert.deepEqual(latest().take(), [], 'nothing until caught up');
    latest().receive({ type: 'ops', from: 1, ops: [insert(1, 'x', null, 'X')] });
    const [sent] = latest().take();
    assert.equal(sent?.type, 'ops');
    assert.equal(sent.ops.length, 1);
    assert.equal(client.unacknowledged, 1);
  });

  test("leaves the outbox when the server echoes it, in order, and an echo isn't applied twice", () => {
    const changes: unknown[][] = [];
    const { client, latest } = setup({ changes, onProgress: () => progress++ });
    let progress = 0;
    client.start();
    latest().open();
    latest().receive(welcome(0));
    client.edit(0, 0, 'ab');
    client.edit(2, 0, 'c');
    const sent = latest()
      .take()
      .flatMap((m) => (m.type === 'ops' ? m.ops : []));
    assert.equal(sent.length, 2);
    latest().receive({ type: 'ops', from: 1, ops: [sent[0] as Op] });
    assert.equal(client.unacknowledged, 1);
    latest().receive({ type: 'ops', from: 2, ops: [sent[1] as Op] });
    assert.equal(client.unacknowledged, 0);
    assert.deepEqual(changes, [], 'echoes change nothing');
    assert.equal(progress, 2, 'but each is progress');
    assert.equal(client.rga.text(), 'abc');
  });

  test("someone else's operation between the echoes is applied and reported", () => {
    const changes: unknown[][] = [];
    const { client, latest } = setup({ changes });
    client.start();
    latest().open();
    latest().receive(welcome(0));
    client.edit(0, 0, 'ab');
    const [mine] = latest()
      .take()
      .flatMap((m) => (m.type === 'ops' ? m.ops : []));
    latest().receive({ type: 'ops', from: 1, ops: [insert(1, 'x', null, 'Z'), mine as Op] });
    assert.equal(client.unacknowledged, 0);
    // 'Z' (1@x) and "ab" (1@me) both start at HEAD; the larger id goes first, and "x" > "me" in code-unit order.
    assert.equal(client.rga.text(), 'Zab');
    assert.deepEqual(changes, [[{ type: 'insert', index: 0, text: 'Z' }]]);
  });

  test('an identical delete from someone else counts as the echo', () => {
    const { client, latest } = setup();
    client.start();
    latest().open();
    latest().receive(welcome(1));
    latest().receive({ type: 'ops', from: 1, ops: [insert(1, 'x', null, 'abc')] });
    client.edit(1, 1, '');
    const [mine] = latest()
      .take()
      .flatMap((m) => (m.type === 'ops' ? m.ops : []));
    latest().receive({ type: 'ops', from: 2, ops: [mine as Op] });
    assert.equal(client.unacknowledged, 0);
    // Its own delete, logged again by the server, then changes nothing.
    latest().receive({ type: 'ops', from: 3, ops: [mine as Op] });
    assert.equal(client.rga.text(), 'ac');
    assert.equal(client.seq, 3);
  });

  test('resends everything not yet echoed on the next connection', () => {
    const { client, latest } = setup();
    client.start();
    latest().open();
    latest().receive(welcome(0));
    client.edit(0, 0, 'a');
    client.edit(1, 0, 'b');
    const first = latest()
      .take()
      .flatMap((m) => (m.type === 'ops' ? m.ops : []));
    latest().receive({ type: 'ops', from: 1, ops: [first[0] as Op] });
    latest().drop();
    assert.equal(client.status, 'offline');
    client.edit(2, 0, 'c');
    return nextTick().then(() => {
      latest().open();
      assert.deepEqual(latest().take(), [
        { type: 'hello', protocol: 1, doc: 'd', replica: 'me', have: 1 },
      ]);
      latest().receive(welcome(1));
      const resent = latest()
        .take()
        .flatMap((m) => (m.type === 'ops' ? m.ops : []));
      assert.equal(resent.length, 2, '"b" and "c", not "a"');
      assert.deepEqual(resent[0], first[1]);
      assert.equal(resent[1]?.type === 'insert' && resent[1].text, 'c');
      assert.equal(client.unacknowledged, 2);
    });
  });

  test('a large outbox goes in batches of at most 1,000 operations', () => {
    const { client, latest } = setup();
    client.start();
    for (let i = 0; i < 2_500; i++) client.edit(i, 0, 'x');
    latest().open();
    latest().take();
    latest().receive(welcome(0));
    assert.deepEqual(
      latest()
        .take()
        .map((m) => (m.type === 'ops' ? m.ops.length : m.type)),
      [1_000, 1_000, 500],
    );
  });
});

describe('hold and release', () => {
  test('holds remote operations until released, while local edits go out', () => {
    const changes: unknown[][] = [];
    const { client, latest } = setup({ changes });
    client.start();
    latest().open();
    latest().receive(welcome(0));
    latest().take();
    client.hold();
    latest().receive({ type: 'ops', from: 1, ops: [insert(1, 'x', null, 'ab')] });
    assert.equal(client.rga.text(), '');
    assert.equal(client.seq, 0);
    client.edit(0, 0, '漢');
    assert.equal(latest().take().length, 1, 'the edit was sent');
    client.release();
    assert.equal(client.seq, 1);
    // Both at HEAD; 1@x is the larger id, so it goes first.
    assert.deepEqual(changes, [[{ type: 'insert', index: 0, text: 'ab' }]]);
    assert.equal(client.rga.text(), 'ab漢');
  });

  test('a dropped connection discards what was held: the next one sends it again', async () => {
    const { client, latest } = setup();
    client.start();
    latest().open();
    latest().receive(welcome(0));
    client.hold();
    latest().receive({ type: 'ops', from: 1, ops: [insert(1, 'x', null, 'ab')] });
    latest().drop();
    await nextTick();
    latest().open();
    assert.deepEqual(latest().take(), [
      { type: 'hello', protocol: 1, doc: 'd', replica: 'me', have: 0 },
    ]);
    latest().receive(welcome(1));
    latest().receive({ type: 'ops', from: 1, ops: [insert(1, 'x', null, 'ab')] });
    client.release();
    assert.equal(client.status, 'online');
    assert.equal(client.rga.text(), 'ab');
  });

  test('stops releasing at a failure', () => {
    const { client, latest } = setup();
    client.start();
    latest().open();
    latest().receive(welcome(0));
    client.hold();
    latest().receive({ type: 'ops', from: 2, ops: [insert(1, 'x', null, 'a')] });
    latest().receive({ type: 'ops', from: 3, ops: [insert(2, 'x', [1, 'x'], 'b')] });
    client.release();
    assert.equal(client.status, 'failed');
    assert.match(client.detail, /from 2, but 0 were applied/);
  });
});

describe('presence', () => {
  test('sends its cursor when it changes and again after reconnecting, after its operations', async () => {
    const { client, latest } = setup();
    client.start();
    latest().open();
    latest().receive(welcome(0));
    client.edit(0, 0, 'ab');
    latest().take();
    client.select({ anchor: 1, head: 2 });
    client.select({ anchor: 1, head: 2 });
    assert.deepEqual(latest().take(), [
      {
        type: 'presence',
        cursor: { anchor: { replica: 'me', counter: 1 }, head: { replica: 'me', counter: 2 } },
      },
    ]);
    latest().drop();
    await nextTick();
    latest().open();
    latest().take();
    latest().receive(welcome(0));
    assert.deepEqual(
      latest()
        .take()
        .map((m) => m.type),
      ['ops', 'presence'],
    );
  });

  test("others' cursors move with the text, and go when they leave or this client drops", () => {
    const { client, latest } = setup();
    client.start();
    latest().open();
    latest().receive(welcome(1));
    latest().receive({ type: 'ops', from: 1, ops: [insert(1, 'x', null, 'abc')] });
    latest().receive({
      type: 'presence',
      replica: 'x',
      cursor: { anchor: { replica: 'x', counter: 2 }, head: null },
    });
    latest().receive({ type: 'presence', replica: 'me', cursor: null });
    const at = (anchor: number, head: number): [string, Selection][] => [['x', { anchor, head }]];
    assert.deepEqual([...client.remoteSelections()], at(2, 0));
    client.edit(0, 0, '12');
    assert.deepEqual([...client.remoteSelections()], at(4, 0));
    // After an element this replica hasn't got: left out.
    latest().receive({
      type: 'presence',
      replica: 'y',
      cursor: { anchor: { replica: 'y', counter: 9 }, head: null },
    });
    assert.equal(client.remoteSelections().size, 1);
    latest().receive({ type: 'presence', replica: 'x', cursor: null });
    assert.equal(client.remoteSelections().size, 0);
    latest().receive({
      type: 'presence',
      replica: 'x',
      cursor: { anchor: null, head: null },
    });
    latest().drop();
    assert.equal(client.remoteSelections().size, 0);
  });
});

describe('failures', () => {
  const join = () => {
    const statuses: [Status, string][] = [];
    const s = setup({ statuses });
    s.client.start();
    s.latest().open();
    s.latest().receive(welcome(0));
    return { ...s, statuses };
  };

  for (const code of [
    'refused-op',
    'malformed',
    'unsupported-protocol',
    'ahead-of-server',
    'too-large',
  ] as const) {
    test(`stops for good on ${code}`, async () => {
      const { client, latest, sockets } = join();
      latest().receive({ type: 'error', code, message: 'no' });
      assert.equal(client.status, 'failed');
      assert.equal(client.detail, `${code}: no`);
      latest().drop(1008);
      await nextTick();
      assert.equal(sockets.length, 1, 'no reconnect');
    });
  }

  test('retries after server-error, with the backoff', async () => {
    const { client, latest, sockets } = join();
    latest().receive({ type: 'error', code: 'server-error', message: 'oops' });
    assert.equal(client.status, 'online');
    latest().drop(1011);
    assert.equal(client.status, 'offline');
    assert.match(client.detail, /closed \(1011\); retrying in 1 ms/);
    await nextTick();
    assert.equal(sockets.length, 2);
  });

  test('the backoff doubles up to its cap, with jitter, and resets once joined', async () => {
    const delays: number[] = [];
    const randoms = [0, 1, 0.5, 1, 1, 1];
    const sockets: FakeSocket[] = [];
    const client = new SyncClient(
      {
        url: 'ws://test/sync',
        doc: 'd',
        connect: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        backoffMs: { initial: 4, max: 16 },
        random: () => randoms.shift() ?? 1,
      },
      {
        onStatus: (status, detail) => {
          const match = /retrying in (\d+) ms/.exec(detail);
          if (status === 'offline' && match !== null) delays.push(Number(match[1]));
        },
      },
    );
    client.start();
    for (let i = 0; i < 5; i++) {
      (sockets.at(-1) as FakeSocket).drop();
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    // 4 * (0.5 + 0/2), 8 * 1, 16 * 0.75, then the cap.
    assert.deepEqual(delays, [2, 8, 12, 16, 16]);
    const socket = sockets.at(-1) as FakeSocket;
    socket.open();
    socket.receive(welcome(0));
    socket.drop();
    assert.deepEqual(delays.at(-1), 4, 'reset after a welcome');
    client.stop();
  });

  test('refuses log entries out of sequence, a second welcome, and a message the protocol forbids', () => {
    for (const bad of [
      (s: FakeSocket) => {
        s.receive({ type: 'ops', from: 2, ops: [insert(1, 'x', null, 'a')] });
      },
      (s: FakeSocket) => {
        s.receive(welcome(0));
      },
      (s: FakeSocket) => {
        s.receive('{"type":"welcome"}');
      },
      (s: FakeSocket) => s.onmessage?.({ data: new ArrayBuffer(1) }),
    ]) {
      const { client, latest } = join();
      bad(latest());
      assert.equal(client.status, 'failed');
      assert.equal(latest().closedWith, 1000);
    }
  });

  test('an operation this replica refuses stops it, after reporting what came before', () => {
    const changes: unknown[][] = [];
    const { client, latest } = setup({ changes });
    client.start();
    latest().open();
    latest().receive(welcome(0));
    latest().receive({
      type: 'ops',
      from: 1,
      ops: [insert(1, 'x', null, 'a'), insert(1, 'x', null, 'b')],
    });
    assert.equal(client.status, 'failed');
    assert.match(client.detail, /refuses log entry 2: 1@x: already known/);
    assert.deepEqual(changes, [[{ type: 'insert', index: 0, text: 'a' }]]);
  });

  test('ops before the welcome are refused', () => {
    const { client, latest } = setup();
    client.start();
    latest().open();
    latest().receive({ type: 'ops', from: 1, ops: [insert(1, 'x', null, 'a')] });
    assert.equal(client.status, 'failed');
  });

  test('stop closes the connection and nothing reconnects', async () => {
    const { client, latest, sockets } = join();
    client.stop();
    assert.equal(client.status, 'stopped');
    assert.equal(latest().closedWith, 1000);
    await nextTick();
    assert.equal(sockets.length, 1);
    client.edit(0, 0, 'still works offline');
    assert.equal(client.rga.text(), 'still works offline');
  });

  test('an error with no close after it is retried, and a close that comes later is ignored', async () => {
    // Node's WebSocket after a refused connection: error, then nothing, readyState CONNECTING for good.
    const { client, sockets, latest } = setup();
    client.start();
    const first = latest();
    first.onerror?.({});
    assert.equal(client.status, 'offline');
    assert.match(client.detail, /^connection failed; retrying/);
    assert.equal(first.closedWith, undefined, 'closed with no code');
    assert.equal(first.readyState, 3);
    await nextTick();
    assert.equal(sockets.length, 2);
    first.drop();
    await nextTick();
    assert.equal(sockets.length, 2, 'the late close started nothing');
    client.stop();
  });

  test('a connect that throws is retried', async () => {
    let calls = 0;
    const client = new SyncClient({
      url: 'ws://test/sync',
      doc: 'd',
      connect: () => {
        calls++;
        throw new Error('blocked');
      },
      backoffMs: { initial: 1, max: 1 },
    });
    client.start();
    assert.equal(client.status, 'offline');
    assert.match(client.detail, /can't connect: blocked/);
    await nextTick();
    assert.ok(calls >= 2);
    client.stop();
  });
});

describe('randomReplica', () => {
  test('is 22 characters of base64url, and differs each time', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1_000; i++) {
      const id = randomReplica();
      assert.match(id, /^[A-Za-z0-9_-]{22}$/);
      ids.add(id);
    }
    assert.equal(ids.size, 1_000);
  });
});
