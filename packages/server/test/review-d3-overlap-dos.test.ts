// Review 3 of day 3: one ops message of deletes with overlapping spans blocks the server for seconds.
//
// What is wrong: the decoder lets a delete name the same ids in all of its 1,000 spans, each up to 10,000 long.
// DocumentHub.#check (hub.ts) asks Rga.ready, which is cheap (run by run), and then Rga.apply walks every id the
// spans name, one IdMap lookup each (rga.ts #delete, `for (let i = 0; i < span.length; i++)`, and before it
// #checkDeleteRoom's counting pass, which runs because 10^7 named ids pass the capacity). So one delete of about 43 KB
// costs 2 x 10^7 lookups, and a 1 MiB message carries 23 of them: about 5 s with the event loop blocked (measured
// 5.3 s on this Mac), during which no other client of any document is served. A client can send them back to back.
// Each one is also logged (deletes are logged every time), so every client in the document and every later joiner
// repeats the work in its own replica.
//
// Right behaviour: nothing a client sends stops the server serving the others (server.ts claims it, and DESIGN.md
// "The sync protocol" limits messages to 1 MiB for this reason). The server should refuse a delete whose spans
// overlap (no honest replica writes one: Rga.edit's spans are disjoint), or bound the work per message by its size.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeClientMessage, type Op } from '@coedit/crdt';
import { DocumentHub, type Member } from '../src/hub.ts';

test('one ops message under 1 MiB is handled in well under a second', () => {
  const hub = new DocumentHub('d');
  const member: Member = { replica: 'a', send() {}, replace() {}, fail() {} };
  hub.join(member, 0);
  hub.submit(member, [
    { type: 'insert', id: { replica: 'a', counter: 1 }, origin: null, text: 'x'.repeat(10_000) },
  ]);
  const del: Op = {
    type: 'delete',
    spans: Array.from({ length: 1_000 }, () => ({ replica: 'a', counter: 1, length: 10_000 })),
  };
  const ops: Op[] = Array.from({ length: 23 }, () => del);
  assert.ok(encodeClientMessage({ type: 'ops', ops }).length < 1 << 20);
  const start = performance.now();
  const refusal = hub.submit(member, ops);
  const ms = performance.now() - start;
  assert.ok(
    ms < 1_000,
    `one message kept the server busy for ${Math.round(ms)} ms (refusal: ${JSON.stringify(refusal)})`,
  );
});
