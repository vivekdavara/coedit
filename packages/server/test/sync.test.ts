// The sync endpoint over real WebSockets (src/server.ts): the handshake, the message flow through a hub, and every
// way a connection is refused or closed. The hub's own rules are in hub.test.ts.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { WebSocket } from 'ws';
import { MAX_MESSAGE_BYTES, type Cursor, type InsertOp, type Op } from '@coedit/crdt';
import { CLOSE_REPLACED, startServer, type SyncServer } from '../src/server.ts';
import { TestClient } from './client.ts';

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

let docs = 0;
/** A document name no other test uses: the server keeps every document for its lifetime. */
const freshDoc = () => `doc-${++docs}`;

/** Waits until `condition` holds, checking every 10 ms, for up to `ms`. */
async function eventually(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('the sync endpoint', () => {
  let server: SyncServer;
  before(async () => {
    server = await startServer({ port: 0, helloTimeoutMs: 1_000 });
  });
  after(() => server.close());

  test('relays each operation, numbered, to every client of the document', async () => {
    const doc = freshDoc();
    const [a, welcome] = await TestClient.join(server, doc, 'a');
    assert.deepEqual(welcome, { type: 'welcome', protocol: 1, doc, seq: 0 });
    const [b] = await TestClient.join(server, doc, 'b');
    const [other] = await TestClient.join(server, freshDoc(), 'c');
    const ops: Op[] = [insert(1, 'a', null, 'hi')];
    a.send({ type: 'ops', ops });
    assert.deepEqual(await a.next(), { type: 'ops', from: 1, ops }, 'the echo');
    assert.deepEqual(await b.next(), { type: 'ops', from: 1, ops });
    b.send({ type: 'ops', ops: [insert(3, 'b', [2, 'a'], '!')] });
    assert.deepEqual(await a.next(), {
      type: 'ops',
      from: 2,
      ops: [insert(3, 'b', [2, 'a'], '!')],
    });
    // A client joining later catches up from its have.
    const [c, late] = await TestClient.join(server, doc, 'c', 1);
    assert.equal(late.seq, 2);
    assert.deepEqual(await c.next(), {
      type: 'ops',
      from: 2,
      ops: [insert(3, 'b', [2, 'a'], '!')],
    });
    // The other document saw nothing.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(other.queued, 0);
    for (const client of [a, b, c, other]) client.close();
  });

  test('presence goes to the others, later joiners get it, and leaving sends null', async () => {
    const doc = freshDoc();
    const [a] = await TestClient.join(server, doc, 'a');
    a.send({ type: 'ops', ops: [insert(1, 'a', null, 'x')] });
    await a.next();
    const [b] = await TestClient.join(server, doc, 'b');
    await b.next(); // the log
    const cursor: Cursor = { anchor: { replica: 'a', counter: 1 }, head: null };
    a.send({ type: 'presence', cursor });
    assert.deepEqual(await b.next(), { type: 'presence', replica: 'a', cursor });
    const [c] = await TestClient.join(server, doc, 'c');
    await c.next(); // the log
    assert.deepEqual(await c.next(), { type: 'presence', replica: 'a', cursor });
    a.close();
    assert.deepEqual(await b.next(), { type: 'presence', replica: 'a', cursor: null });
    assert.deepEqual(await c.next(), { type: 'presence', replica: 'a', cursor: null });
    b.close();
    c.close();
  });

  test('a refused operation gets an error and the connection closes; the others get what came before it', async () => {
    const doc = freshDoc();
    const [a] = await TestClient.join(server, doc, 'a');
    const [b] = await TestClient.join(server, doc, 'b');
    const ok = insert(1, 'a', null, 'x');
    a.send({ type: 'ops', ops: [ok, insert(9, 'a', [8, 'a'], 'y')] });
    assert.deepEqual(await a.next(), { type: 'ops', from: 1, ops: [ok] });
    const message = await a.expectError('refused-op');
    assert.match(message, /ops\[1\] refused: its origin 8@a/);
    assert.deepEqual(await b.next(), { type: 'ops', from: 1, ops: [ok] });
    assert.deepEqual(await b.next(), { type: 'presence', replica: 'a', cursor: null });
    b.close();
  });

  test('refuses what the protocol does not allow, each with its error code', async () => {
    const cases: [send: (c: TestClient) => void, code: string, pattern: RegExp][] = [
      [
        (c) => {
          c.send('{"type":"hello"');
        },
        'malformed',
        /not valid JSON/,
      ],
      [
        (c) => {
          c.send('{"type":"hello","protocol":1}');
        },
        'malformed',
        /doc: missing/,
      ],
      [
        (c) => {
          c.ws.send(Buffer.from('{}'), { binary: true });
        },
        'malformed',
        /binary/,
      ],
      [
        (c) => {
          c.send({ type: 'ops', ops: [insert(1, 'a', null, 'x')] });
        },
        'unexpected-message',
        /ops before hello/,
      ],
      [
        (c) => {
          c.send({ type: 'presence', cursor: null });
        },
        'unexpected-message',
        /presence before hello/,
      ],
      [
        (c) => {
          c.send({ type: 'hello', protocol: 2, doc: 'd', replica: 'a', have: 0 });
        },
        'unsupported-protocol',
        /speaks protocol 1, not 2/,
      ],
      [
        (c) => {
          c.send({ type: 'hello', protocol: 1, doc: freshDoc(), replica: 'a', have: 5 });
        },
        'ahead-of-server',
        /applied 5 log entries/,
      ],
    ];
    for (const [send, code, pattern] of cases) {
      const client = await TestClient.open(server);
      send(client);
      assert.match(await client.expectError(code), pattern, code);
    }
  });

  test('a second hello is refused', async () => {
    const [a] = await TestClient.join(server, freshDoc(), 'a');
    a.send({ type: 'hello', protocol: 1, doc: 'd', replica: 'a', have: 0 });
    assert.match(await a.expectError('unexpected-message'), /already joined/);
  });

  test('a connection that does not say hello in time is closed', async () => {
    const client = await TestClient.open(server);
    const started = Date.now();
    assert.match(await client.expectError('unexpected-message'), /no hello within 1000 ms/);
    assert.ok(Date.now() - started >= 900);
  });

  test('a message over 1 MiB closes the connection with 1009', async () => {
    const [a] = await TestClient.join(server, freshDoc(), 'a');
    a.send(`{"type":"presence","cursor":null,"pad":"${'x'.repeat(MAX_MESSAGE_BYTES)}"}`);
    assert.equal((await a.closed).code, 1009);
  });

  test('a message of exactly 1 MiB is read (and here refused for what it says)', async () => {
    const [a] = await TestClient.join(server, freshDoc(), 'a');
    const head = '{"type":"presence","cursor":null,"pad":"';
    const tail = '"}';
    a.send(`${head}${'x'.repeat(MAX_MESSAGE_BYTES - head.length - tail.length)}${tail}`);
    assert.match(await a.expectError('malformed'), /pad: unknown field/);
  });

  test('a newer connection of the same replica replaces the older one', async () => {
    const doc = freshDoc();
    const [old] = await TestClient.join(server, doc, 'a');
    const [b] = await TestClient.join(server, doc, 'b');
    const [renewed] = await TestClient.join(server, doc, 'a');
    assert.deepEqual(await old.closed, {
      code: CLOSE_REPLACED,
      reason: 'replaced by a newer connection',
    });
    assert.deepEqual(await b.next(), { type: 'presence', replica: 'a', cursor: null });
    // The old connection's close doesn't announce the new one gone.
    renewed.send({ type: 'presence', cursor: null });
    assert.deepEqual(await b.next(), { type: 'presence', replica: 'a', cursor: null });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(b.queued, 0);
    b.close();
    renewed.close();
  });

  test('other paths are refused with 404', async () => {
    await assert.rejects(
      TestClient.open(server, { path: '/nope' }),
      /Unexpected server response: 404/,
    );
    await assert.rejects(TestClient.open(server, { path: '/sync/' }), /404/);
  });
});

describe('origins', () => {
  let server: SyncServer;
  before(async () => {
    server = await startServer({ port: 0, origins: ['http://localhost:5173'] });
  });
  after(() => server.close());

  test('a page from an allowed origin connects; others are refused with 403', async () => {
    const allowed = await TestClient.open(server, { origin: 'http://localhost:5173' });
    allowed.close();
    for (const origin of [
      'http://evil.example',
      'http://localhost:5174',
      'null',
      'http://localhost:5173/',
    ]) {
      await assert.rejects(TestClient.open(server, { origin }), /403/, origin);
    }
  });

  test('a handshake without an Origin header (not a browser) is let through', async () => {
    const client = await TestClient.open(server);
    client.close();
  });

  test('by default the client dev server is allowed', async () => {
    const other = await startServer({ port: 0 });
    try {
      for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
        (await TestClient.open(other, { origin })).close();
      }
      await assert.rejects(TestClient.open(other, { origin: 'http://localhost:8110' }), /403/);
    } finally {
      await other.close();
    }
  });
});

describe('a client that stops reading', () => {
  test('is dropped once too much is queued for it, and the others carry on', async () => {
    const server = await startServer({ port: 0, maxBufferedBytes: 256 * 1024 });
    try {
      const doc = freshDoc();
      const [writer] = await TestClient.join(server, doc, 'w');
      const [stalled] = await TestClient.join(server, doc, 's');
      // Stop reading: the kernel's buffers fill, then the server's queue for it grows.
      (stalled.ws as unknown as { _socket: { pause(): void } })._socket.pause();
      // A function, not the property: after an assertion on it TypeScript would take the value as fixed.
      const open = () => server.connections;
      assert.equal(open(), 2);
      // Send until the server drops it: how much the kernel absorbs first differs a lot between macOS and Linux,
      // so no fixed amount is right for both. Bounded at about 400 MB.
      let counter = 1;
      let origin: [number, string] | null = null;
      for (let i = 0; i < 4_000 && open() === 2; i++) {
        const op = insert(counter, 'w', origin, 'x'.repeat(10_000));
        writer.send({ type: 'ops', ops: [op] });
        await writer.next();
        origin = [counter + 9_999, 'w'];
        counter += 10_000;
      }
      await eventually(() => open() === 1);
      // The writer sees it leave, and is still served.
      assert.deepEqual(await writer.next(), { type: 'presence', replica: 's', cursor: null });
      writer.send({ type: 'ops', ops: [insert(counter, 'w', origin, '!')] });
      const echo = await writer.next();
      assert.equal(echo.type, 'ops');
      writer.close();
    } finally {
      await server.close();
    }
  });
});

describe('close', () => {
  test('ends every sync connection', async () => {
    const server = await startServer({ port: 0 });
    const [a] = await TestClient.join(server, 'd', 'a');
    const pending = await TestClient.open(server);
    await server.close();
    assert.equal((await a.closed).code, 1006);
    assert.equal((await pending.closed).code, 1006);
    assert.equal(a.ws.readyState, WebSocket.CLOSED);
  });
});
