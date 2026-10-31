// Review 2 of day 3's fixes: f0e4ef8 bounds one delete's cost, not one message's.
//
// What is wrong: DocumentHub.#check (hub.ts, `if (op.type === 'delete' && overlapping(op.spans))`) refuses a delete
// whose spans overlap, and its comment concludes "a delete's cost is bounded by the document's size". But a message
// carries up to MAX_OPS (1,000) operations, and nothing stops all of them naming the same ids: each one alone has
// disjoint spans, so each passes. Rga #delete (rga.ts, `for (let i = 0; i < span.length; i++)`) still looks up every id
// named, deleted or not, so one message costs MAX_OPS x the document's size in lookups. Here a 200,000-character
// document (20 inserts of 10,000) and one 0.9 MiB message of 1,000 deletes, each naming the whole document as 20
// spans of 10,000: 2 x 10^8 lookups with the event loop blocked (measured 3.9 s on this Mac; the first review's
// overlapping message took 5.3 s).
// Each delete is logged (deletes are logged every time they come), so every member and every later joiner repeats
// the work in its own replica too.
//
// Right behaviour: as the first review's test says, one message under 1 MiB is handled in well under a second. For
// example, refuse a message whose deletes together name more ids than the document holds: an honest client's
// outbox deletes each element at most once, so it never sends more.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeClientMessage, MAX_OPS, type Op } from '@coedit/crdt';
import { DocumentHub, type Member } from '../src/hub.ts';

test('one ops message of deletes that each name the whole document is handled in well under a second', () => {
  const hub = new DocumentHub('d');
  const member: Member = { replica: 'a', send() {}, replace() {}, fail() {} };
  hub.join(member, 0);
  const runs = 20;
  const inserts: Op[] = [];
  for (let r = 0; r < runs; r++) {
    inserts.push({
      type: 'insert',
      id: { replica: 'a', counter: r * 10_000 + 1 },
      origin: r === 0 ? null : { replica: 'a', counter: r * 10_000 },
      text: 'x'.repeat(10_000),
    });
  }
  assert.equal(hub.submit(member, inserts), null);
  assert.equal(hub.text().length, runs * 10_000);

  // Disjoint spans: each delete alone is what Rga.edit writes for deleting the whole document.
  const del: Op = {
    type: 'delete',
    spans: Array.from({ length: runs }, (_, r) => ({
      replica: 'a',
      counter: r * 10_000 + 1,
      length: 10_000,
    })),
  };
  const ops: Op[] = Array.from({ length: MAX_OPS }, () => del);
  assert.ok(encodeClientMessage({ type: 'ops', ops }).length < 1 << 20);

  const start = performance.now();
  const refusal = hub.submit(member, ops);
  const ms = performance.now() - start;
  assert.ok(
    ms < 1_000,
    `one message kept the server busy for ${Math.round(ms)} ms (refusal: ${JSON.stringify(refusal)})`,
  );
});
