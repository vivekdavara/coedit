// The sync client against the real server, over real WebSockets (Node's own): clients converge with the server,
// edits made offline arrive, cursors travel, and the failures a user can meet end the way the client says.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startServer, type SyncServer } from '@coedit/server';
import type { Change } from '@coedit/crdt';
import { SyncClient, type Status } from '../src/sync.ts';
import { applyEdit } from '../src/edit.ts';

/** Waits until `condition` holds, checking every 5 ms, for up to `ms`. */
export async function eventually(condition: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let docs = 0;
const freshDoc = () => `doc-${++docs}`;

/** A client with fast retries that also keeps a text patched only by the changes it reports, as the editor does. */
function client(
  server: SyncServer | { host: string; port: number },
  doc: string,
  replica?: string,
) {
  const statuses: Status[] = [];
  let shown = '';
  const c = new SyncClient(
    {
      url: `ws://${server.host}:${server.port}/sync`,
      doc,
      ...(replica === undefined ? {} : { replica }),
      backoffMs: { initial: 5, max: 50 },
    },
    {
      onStatus: (status) => statuses.push(status),
      onChanges: (changes: readonly Change[]) => {
        for (const change of changes) {
          shown =
            change.type === 'insert'
              ? applyEdit(shown, { index: change.index, deleteCount: 0, text: change.text })
              : applyEdit(shown, { index: change.index, deleteCount: change.count, text: '' });
        }
      },
    },
  );
  const edit = (index: number, deleteCount: number, text: string) => {
    c.edit(index, deleteCount, text);
    shown = applyEdit(shown, { index, deleteCount, text });
  };
  return { c, statuses, edit, shown: () => shown };
}

/** Every client is online with nothing unacknowledged and the whole log applied, and agrees with the server. */
async function settled(server: SyncServer, doc: string, clients: SyncClient[]): Promise<void> {
  await eventually(() => {
    const seq = server.inspect(doc)?.seq;
    return clients.every((c) => c.status === 'online' && c.unacknowledged === 0 && c.seq === seq);
  });
  const expected = server.inspect(doc);
  assert.ok(expected !== undefined);
  for (const c of clients) {
    assert.equal(c.rga.text(), expected.text, c.replica);
    assert.equal(c.rga.state(), expected.state, `${c.replica}'s state`);
  }
}

describe('clients and the server', () => {
  let server: SyncServer;
  before(async () => {
    server = await startServer({ port: 0 });
  });
  after(() => server.close());

  test('two clients typing converge with each other and the server', async () => {
    const doc = freshDoc();
    const a = client(server, doc);
    const b = client(server, doc);
    a.c.start();
    b.c.start();
    await eventually(() => a.c.status === 'online' && b.c.status === 'online');
    a.edit(0, 0, 'hello');
    await eventually(() => b.c.rga.text() === 'hello');
    b.edit(5, 0, ' world');
    a.edit(0, 1, 'H');
    await settled(server, doc, [a.c, b.c]);
    assert.equal(a.c.rga.text(), 'Hello world');
    // The text patched only by the reported changes is the replica's.
    assert.equal(a.shown(), a.c.rga.text());
    assert.equal(b.shown(), b.c.rga.text());
    assert.deepEqual(a.statuses.slice(0, 3), ['connecting', 'syncing', 'online']);
    a.c.stop();
    b.c.stop();
  });

  test('edits made offline arrive when the connection comes back', async () => {
    const doc = freshDoc();
    const a = client(server, doc);
    const b = client(server, doc);
    a.c.start();
    b.c.start();
    await eventually(() => a.c.status === 'online' && b.c.status === 'online');
    a.edit(0, 0, 'shared ');
    await settled(server, doc, [a.c, b.c]);
    a.c.disconnect();
    assert.equal(a.c.status, 'offline');
    a.edit(7, 0, 'offline-a');
    b.edit(7, 0, 'online-b');
    await settled(server, doc, [a.c, b.c]);
    // Both runs went after "shared ", each whole; their ids decide which comes first, the same everywhere.
    const text = a.c.rga.text();
    assert.ok(text === 'shared offline-aonline-b' || text === 'shared online-boffline-a', text);
    assert.equal(a.shown(), text);
    assert.equal(b.shown(), text);
    a.c.stop();
    b.c.stop();
  });

  test('a client joining late catches up on the whole log, in batches', async () => {
    const doc = freshDoc();
    const a = client(server, doc);
    a.c.start();
    await eventually(() => a.c.status === 'online');
    for (let i = 0; i < 2_500; i++) a.edit(i, 0, String(i % 10));
    await settled(server, doc, [a.c]);
    assert.equal(server.inspect(doc)?.seq, 2_500);
    const late = client(server, doc);
    late.c.start();
    await settled(server, doc, [a.c, late.c]);
    assert.equal(late.shown(), a.c.rga.text());
    a.c.stop();
    late.c.stop();
  });

  test('cursors travel, follow the text, and go when their client stops', async () => {
    const doc = freshDoc();
    const a = client(server, doc, 'aaa');
    const b = client(server, doc, 'bbb');
    a.c.start();
    b.c.start();
    await eventually(() => a.c.status === 'online' && b.c.status === 'online');
    a.edit(0, 0, 'abcdef');
    await settled(server, doc, [a.c, b.c]);
    a.c.select({ anchor: 2, head: 4 });
    await eventually(() => b.c.remoteSelections().get('aaa')?.head === 4);
    assert.deepEqual(b.c.remoteSelections().get('aaa'), { anchor: 2, head: 4 });
    b.edit(0, 0, '>>');
    await settled(server, doc, [a.c, b.c]);
    assert.deepEqual(b.c.remoteSelections().get('aaa'), { anchor: 4, head: 6 });
    // A client that joins later sees it too.
    const c = client(server, doc, 'ccc');
    c.c.start();
    await eventually(() => c.c.remoteSelections().has('aaa'));
    a.c.stop();
    await eventually(
      () => !b.c.remoteSelections().has('aaa') && !c.c.remoteSelections().has('aaa'),
    );
    b.c.stop();
    c.c.stop();
  });

  test('a client started before the server is up connects once it is', async () => {
    const probe = await startServer({ port: 0 });
    const address = { host: probe.host, port: probe.port };
    await probe.close();
    const a = client(address, 'early');
    a.c.start();
    a.edit(0, 0, 'typed while no server was up');
    await eventually(() => a.statuses.filter((s) => s === 'offline').length >= 2);
    const late = await startServer({ port: address.port });
    try {
      await settled(late, 'early', [a.c]);
      assert.equal(late.inspect('early')?.text, 'typed while no server was up');
    } finally {
      a.c.stop();
      await late.close();
    }
  });

  test('a server that lost its log refuses the client, which stops and says why', async () => {
    const first = await startServer({ port: 0 });
    const a = client(first, 'lost');
    a.c.start();
    await eventually(() => a.c.status === 'online');
    a.edit(0, 0, 'abc');
    await settled(first, 'lost', [a.c]);
    const port = first.port;
    await first.close();
    const second = await startServer({ port });
    try {
      await eventually(() => a.c.status === 'failed');
      assert.match(a.c.detail, /^ahead-of-server: you have applied 1 log entries/);
      assert.equal(a.c.rga.text(), 'abc', 'the text is still here');
    } finally {
      await second.close();
    }
  });

  test('a document fuller than its capacity refuses the edit, and that client stops', async () => {
    const small = await startServer({ port: 0, capacity: 10 });
    try {
      const a = client(small, 'small');
      const b = client(small, 'small');
      a.c.start();
      b.c.start();
      await eventually(() => a.c.status === 'online' && b.c.status === 'online');
      a.edit(0, 0, 'x'.repeat(8));
      await settled(small, 'small', [a.c, b.c]);
      b.edit(8, 0, 'yyy');
      await eventually(() => b.c.status === 'failed');
      assert.match(b.c.detail, /^too-large: ops\[0\] refused: 3 more elements/);
      // The others carry on.
      a.edit(0, 0, 'z');
      await settled(small, 'small', [a.c]);
      a.c.stop();
    } finally {
      await small.close();
    }
  });
});
