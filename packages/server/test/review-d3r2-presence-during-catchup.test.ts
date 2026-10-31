// Review 2 of day 3's fixes: ca5cdae's catch-up still counts against maxBufferedBytes, through presence.
//
// What is wrong: ServerOptions.maxBufferedBytes (server.ts) now says "The catch-up itself doesn't count: it goes one
// batch at a time", and the catch-up's sends (Member.send with `sent`) skip the slow-reader check. But a member still
// catching up is sent every presence relay (DocumentHub.presence and .leave, hub.ts, `for (const other of
// this.#members.keys())`, which unlike submit don't skip members whose `next` isn't null), and each of those goes
// through the plain send, whose check (server.ts, `if (ws.bufferedAmount > maxBuffered) ws.terminate()`) counts what
// ws still has queued: the catch-up batch in flight, up to 1 MiB. So with a limit under a batch's size, one cursor
// moving anywhere in the document while a client catches up drops that client, and it rejoins with the same `have`
// into the same catch-up. Here: a limit of 16 KiB, a log of about 8 MiB of 4 KB entries, a reader that is slow for
// 300 ms (paused, as a slow link would be), and one 50-byte `presence` from another member meanwhile.
//
// Right behaviour: only live sends count, as the option says: a presence relay of 50 bytes doesn't drop a client
// whose queue is its catch-up batch (count the bytes queued beyond the batch in flight, or hold presence for a member
// still catching up, since the snapshot at the end of its catch-up sends every cursor anyway).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Op } from '@coedit/crdt';
import { startServer } from '../src/server.ts';
import { TestClient } from './client.ts';

test('a presence relay during the catch-up does not drop the client catching up', async () => {
  const server = await startServer({ port: 0, maxBufferedBytes: 16 * 1024 });
  try {
    const [writer] = await TestClient.join(server, 'doc', 'w');
    writer.send({
      type: 'ops',
      ops: [
        { type: 'insert', id: { replica: 'w', counter: 1 }, origin: null, text: 'x'.repeat(200) },
      ],
    });
    await writer.next();
    // Entries of about 4 KB (100 one-id spans), two per message so that no live echo passes the limit, naming
    // different ids (a message's deletes may name at most as many ids as the document holds, since 578c354).
    const halves: Op[] = [0, 100].map((at) => ({
      type: 'delete',
      spans: Array.from({ length: 100 }, (_, i) => ({
        replica: 'w',
        counter: at + i + 1,
        length: 1,
      })),
    }));
    for (let m = 0; m < 1_000; m++) {
      writer.send({ type: 'ops', ops: halves });
      const echo = await writer.next(20_000);
      assert.equal(echo.type, 'ops', JSON.stringify(echo).slice(0, 200));
    }
    const seq = server.inspect('doc')?.seq ?? 0;
    assert.equal(seq, 1 + 2_000);
    const [mover] = await TestClient.join(server, 'doc', 'm');

    const reader = await TestClient.open(server);
    reader.send({ type: 'hello', protocol: 1, doc: 'doc', replica: 'r', have: 0 });
    const socket = (reader.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    socket.pause();
    await new Promise((resolve) => setTimeout(resolve, 200));
    mover.send({ type: 'presence', cursor: null });
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.resume();

    const welcome = await reader.next();
    assert.equal(welcome.type, 'welcome');
    let applied = 0;
    while (applied < seq) {
      const message = await reader.next(3_000).catch(() => null);
      if (message === null) break;
      if (message.type === 'ops') applied += message.ops.length;
    }
    assert.equal(
      applied,
      seq,
      'the server dropped a client that was catching up, on a presence relay',
    );
    reader.close();
    mover.close();
    writer.close();
  } finally {
    await server.close();
  }
});
