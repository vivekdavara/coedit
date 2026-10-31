// Review 2 of day 3's fixes: ca5cdae's catch-up measures up to 1,000 entries for every batch it sends.
//
// What is wrong: DocumentHub.#catchUp (hub.ts, `batchOps(this.#log.slice(next - 1, next - 1 + MAX_OPS))[0]`) finds
// each batch by running batchOps over the next MAX_OPS entries and keeping only the first batch. batchOps measures
// every entry it is given (utf8Length, a loop over each character), so when entries are big a batch holds few of them
// and the rest are measured for nothing, again for the next batch. With entries of about 40 KB (deletes of 1,000
// spans; up to about 90 KB is allowed), a batch holds 25 and each one costs measuring 1,000: 40 times the work
// writing the log once did. Measured: a log of 3,000 such entries (117 MiB) took 180 ms to batch and encode the old
// way and 5.5 s this way, in steps of about 45 ms with the event loop blocked (this test's log of 1,500: 90 ms
// and 2.2 s). Every client that joins (or reconnects with an old `have`) costs that again, and clients choose both
// the entry sizes and when to rejoin.
//
// Right behaviour: a catch-up's work is in proportion to what it sends: take entries from `next` until the next one
// wouldn't fit (or MAX_OPS), measuring only those, so the whole catch-up costs about what batching the log once did.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchOps, encodeOp, encodeServerOps, type Op } from '@coedit/crdt';
import { DocumentHub, type Member } from '../src/hub.ts';

test("a catch-up's work is in proportion to what it sends", () => {
  const hub = new DocumentHub('d');
  const writer: Member = { replica: 'w', send() {}, replace() {} };
  hub.join(writer, 0);
  hub.submit(writer, [insertOf()]);
  // Ten deletes of about 40 KB a message, naming 10,000 different ids: the server refuses a message whose deletes
  // name more ids than the document holds (578c354, after this test was written with one delete repeated).
  const deletes: Op[] = Array.from({ length: 10 }, (_, k) => ({
    type: 'delete',
    spans: Array.from({ length: 1_000 }, (_, i) => ({
      replica: 'w',
      counter: k * 1_000 + i + 1,
      length: 1,
    })),
  }));
  for (let m = 0; m < 150; m++) assert.equal(hub.submit(writer, deletes), null);

  // What writing the same log once costs: batch it and encode every message.
  const log = [encodeOp(insertOf())];
  for (let i = 1; i < hub.seq; i++) log.push(encodeOp(deletes[(i - 1) % 10] as Op));
  let start = performance.now();
  let from = 1;
  for (const batch of batchOps(log)) {
    encodeServerOps(from, batch);
    from += batch.length;
  }
  const once = performance.now() - start;

  // A member whose writes complete at once: its whole catch-up runs inside join.
  let bytes = 0;
  const reader: Member = {
    replica: 'r',
    send(text, sent) {
      bytes += text.length;
      sent?.();
    },
    replace() {},
  };
  start = performance.now();
  hub.join(reader, 0);
  const catchUp = performance.now() - start;
  assert.ok(bytes > 50 * 2 ** 20, `only ${bytes} bytes were sent`);
  assert.ok(
    catchUp < 5 * once + 50,
    `the catch-up took ${Math.round(catchUp)} ms; batching and encoding the same log once takes ${Math.round(once)} ms`,
  );
});

function insertOf(): Op {
  return {
    type: 'insert',
    id: { replica: 'w', counter: 1 },
    origin: null,
    text: 'x'.repeat(10_000),
  };
}
