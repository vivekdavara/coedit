// Review 3 of day 3: a joining client whose catch-up is bigger than maxBufferedBytes can never join.
//
// What is wrong: DocumentHub.join (hub.ts, the `for (const batch of batchOps(this.#log.slice(have)))` loop) writes
// the whole catch-up synchronously, and the member's send (server.ts, `if (ws.bufferedAmount > maxBuffered)
// ws.terminate()`) counts everything queued so far. A client that reads as fast as it can is still dropped part way
// through the catch-up once the log after its `have` is bigger than the limit plus what the kernel absorbs, and since
// it then reconnects with the same `have`, it is dropped the same way every time. The server's doc comment says
// "the client reconnects and catches up from the log"; with a log of more than about 16 MiB (the default: about
// 150,000 keystrokes of one-character inserts) no new client can open the document at all.
//
// Right behaviour: a client that keeps reading gets its whole catch-up (the server writes the catch-up as the socket
// drains, or doesn't count the catch-up against the slow-reader limit), so a fresh client joining a long document
// reaches the end of the log.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Op } from '@coedit/crdt';
import { startServer } from '../src/server.ts';
import { TestClient } from './client.ts';

test('a client reading as fast as it can gets its whole catch-up, however long the log', async () => {
  const server = await startServer({ port: 0, maxBufferedBytes: 256 * 1024 });
  try {
    const [writer] = await TestClient.join(server, 'long', 'w');
    writer.send({
      type: 'ops',
      ops: [
        { type: 'insert', id: { replica: 'w', counter: 1 }, origin: null, text: 'x'.repeat(5_000) },
      ],
    });
    await writer.next();
    // A log of about 32 MiB: deletes are logged every time they come (here, 5 of about 40 KB per message, so that no
    // one echo passes the limit). Each names 1,000 ids as 1,000 one-id spans, the five of a message 5,000 different
    // ids: the server refuses overlapping spans (f0e4ef8) and a message naming more ids than the document holds
    // (review 2); the review's first version named one id 5,000 times a message.
    const deletes: Op[] = Array.from({ length: 5 }, (_, k) => ({
      type: 'delete',
      spans: Array.from({ length: 1_000 }, (_, i) => ({
        replica: 'w',
        counter: k * 1_000 + i + 1,
        length: 1,
      })),
    }));
    for (let m = 0; m < 160; m++) {
      writer.send({ type: 'ops', ops: deletes });
      const echo = await writer.next(20_000);
      assert.equal(echo.type, 'ops', JSON.stringify(echo).slice(0, 200));
    }
    const seq = server.inspect('long')?.seq ?? 0;
    assert.equal(seq, 1 + 160 * 5);
    writer.close();

    // A fresh client, reading everything it is sent.
    const [reader, welcome] = await TestClient.join(server, 'long', 'r');
    assert.equal(welcome.seq, seq);
    let applied = 0;
    while (applied < seq) {
      const message = await reader.next(10_000).catch(() => null);
      if (message === null || message.type !== 'ops') break;
      applied += message.ops.length;
    }
    assert.equal(applied, seq, 'the server dropped a client that was reading its catch-up');
    reader.close();
  } finally {
    await server.close();
  }
});
