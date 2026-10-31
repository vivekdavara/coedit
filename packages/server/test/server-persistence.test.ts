// The sync server with a data directory (src/server.ts, DESIGN.md "Persistence (day 4)"): documents outlive the
// server, idle ones are unloaded and loaded again, and a document whose storage fails is closed and reloaded.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { Rga, type Op, type ServerMessage } from '@coedit/crdt';
import { startServer, type ServerOptions, type SyncServer } from '../src/server.ts';
import { directoryName } from '../src/store.ts';
import { TestClient } from './client.ts';

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-server-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function server(t: TestContext, options: ServerOptions): Promise<SyncServer> {
  const s = await startServer({ port: 0, fsync: false, ...options });
  t.after(() => s.close());
  return s;
}

async function eventually(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Joins, sends `text` typed one character a message, and waits for every echo. */
async function typed(s: SyncServer, doc: string, replica: string, text: string) {
  const [client, welcome] = await TestClient.join(s, doc, replica);
  const rga = new Rga(replica);
  const ops: Op[] = [];
  for (const c of text) ops.push(...rga.edit(rga.length, 0, c));
  for (const op of ops) client.send({ type: 'ops', ops: [op] });
  let seq = welcome.seq;
  while (seq < welcome.seq + ops.length) {
    const m = await client.next();
    if (m.type === 'ops') seq = m.from + m.ops.length - 1;
  }
  return { client, rga, seq };
}

/** Everything a client joining with `have` receives until it is caught up to `seq`, then the replica it builds. */
async function caughtUp(s: SyncServer, doc: string, have: number, rga = new Rga('late')) {
  const [client, welcome] = await TestClient.join(s, doc, rga.replica, have);
  const messages: ServerMessage[] = [];
  let seq = have;
  while (seq < welcome.seq) {
    const m = await client.next();
    messages.push(m);
    if (m.type === 'ops') {
      for (const op of m.ops) rga.apply(op);
      seq = m.from + m.ops.length - 1;
    } else if (m.type === 'snapshot') {
      for (const op of m.ops) rga.apply(op);
      if (m.last) seq = m.seq;
    }
  }
  return { client, welcome, messages, rga };
}

describe('a server with a data directory', () => {
  test('keeps documents across a restart: same log, same text, and no ahead-of-server', async (t) => {
    const dataDir = tempDir(t);
    const first = await startServer({ port: 0, fsync: false, dataDir });
    const { client, seq } = await typed(first, 'notes', 'a', 'kept across restarts');
    client.close();
    await first.close();

    const second = await server(t, { dataDir });
    const late = await caughtUp(second, 'notes', 0);
    assert.equal(late.welcome.seq, seq);
    assert.equal(late.rga.text(), 'kept across restarts');
    // The writer comes back with everything it had applied.
    const [back, welcome] = await TestClient.join(second, 'notes', 'a', seq);
    assert.equal(welcome.seq, seq);
    back.close();
    late.client.close();
  });

  test('unloads a document nobody has open after the idle time, and loads it again on the next join', async (t) => {
    const dataDir = tempDir(t);
    const s = await server(t, { dataDir, idleMs: 50 });
    const { client } = await typed(s, 'idle', 'a', 'abc');
    assert.equal(s.inspect('idle')?.text, 'abc');
    client.close();
    await eventually(() => s.inspect('idle') === undefined);
    const late = await caughtUp(s, 'idle', 0);
    assert.equal(late.rga.text(), 'abc');
    assert.equal(s.inspect('idle')?.text, 'abc');
    late.client.close();
  });

  test('keeps a document loaded while anyone has it open, and after a refused hello it goes idle', async (t) => {
    const dataDir = tempDir(t);
    const s = await server(t, { dataDir, idleMs: 50 });
    const { client } = await typed(s, 'busy', 'a', 'x');
    const [other] = await TestClient.join(s, 'busy', 'b');
    other.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(s.inspect('busy')?.text, 'x', 'a is still connected');
    client.close();
    await eventually(() => s.inspect('busy') === undefined);
    // A hello the hub refuses loads the document, and mustn't leave it loaded for good.
    const refused = await TestClient.open(s);
    refused.send({ type: 'hello', protocol: 1, doc: 'busy', replica: 'c', have: 99 });
    await refused.expectError('ahead-of-server');
    await eventually(() => s.inspect('busy') === undefined);
  });

  test('closes a document whose log write fails, and loads it from disk on the next join', async (t) => {
    const dataDir = tempDir(t);
    const s = await server(t, { dataDir });
    const { client: a, rga, seq } = await typed(s, 'full', 'a', 'ok');
    const [b] = await TestClient.join(s, 'full', 'b', seq);
    t.mock.method(fs, 'writeSync', () => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    a.send({ type: 'ops', ops: rga.edit(2, 0, '!') });
    await a.expectError('server-error', 1011);
    t.mock.restoreAll();
    // b gets the error too, and nothing of the lost edit.
    for (;;) {
      const m = await b.next();
      assert.notEqual(m.type, 'ops', JSON.stringify(m));
      if (m.type === 'error') {
        assert.equal(m.code, 'server-error');
        break;
      }
    }
    assert.equal(s.inspect('full'), undefined);
    const late = await caughtUp(s, 'full', 0);
    assert.equal(late.rga.text(), 'ok');
    late.client.close();
  });

  test("refuses a hello for a document whose files don't read back, and serves the others", async (t) => {
    const dataDir = tempDir(t);
    const s = await server(t, { dataDir });
    const { client } = await typed(s, 'good', 'a', 'fine');
    client.close();
    const bad = path.join(dataDir, directoryName('Bad'));
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, 'log-0000000000000001.jsonl'), '{"seq":1,"op":nonsense}\n');
    const errors = t.mock.method(console, 'error', () => {});
    const refused = await TestClient.open(s);
    refused.send({ type: 'hello', protocol: 1, doc: 'Bad', replica: 'c', have: 0 });
    await refused.expectError('server-error', 1011);
    assert.ok(errors.mock.callCount() >= 1);
    t.mock.restoreAll();
    const late = await caughtUp(s, 'good', 0);
    assert.equal(late.rga.text(), 'fine');
    late.client.close();
  });

  test('sends a snapshot to a client older than the log kept, which leaves it where the others are', async (t) => {
    const dataDir = tempDir(t);
    const s = await server(t, { dataDir, snapshotEvery: 10 });
    const { client, rga, seq } = await typed(s, 'snap', 'a', 'x'.repeat(35));
    // One that applied entries 1 to 3 (from a fresh copy of the first three operations).
    const behind = new Rga('b');
    const first = new Rga('a');
    for (let i = 0; i < 3; i++) for (const op of first.edit(i, 0, 'x')) behind.apply(op);
    const late = await caughtUp(s, 'snap', 3, behind);
    assert.ok(late.messages.some((m) => m.type === 'snapshot'));
    assert.equal(late.welcome.seq, seq);
    assert.equal(late.rga.state(), rga.state());
    client.close();
    late.client.close();
  });
});
