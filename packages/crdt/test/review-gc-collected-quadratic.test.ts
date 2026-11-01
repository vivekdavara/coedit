// Review of the tombstone collection (2a26ec5): loading collected ids is quadratic in the number of spans.
//
// What's wrong: Rga.markCollected adds each span with IdRanges.addSpan, and addSpan (#merge) copies, sorts and
// re-merges the replica's whole range list every time: m spans cost O(m^2 log m). markCollected is how the hub loads
// a snapshot (DocumentHub's constructor, which blocks the server's event loop for every document) and how a client
// rebuilds from one (SyncClient's `snapshot` case). Collection takes typos and short deletions all over a document,
// so the collected ids come as many short spans, not "mostly in long runs" as IdRanges' comment assumes: the
// synthetic 100,000-edit session of `npm run editing -w @coedit/crdt` keeps 35,414 collected ids as 8,809 spans.
// Measured on this Mac, markCollected of disjoint spans: 8,809 spans 1.0 s (more than the 344-481 ms README gives for
// loading that whole document), 20,000 spans 7.1 s, 40,000 spans 37.6 s; and the spans only accumulate over a
// document's life, so every later load and every client rebuild gets slower, quadratically.
//
// Right behaviour: loading m spans costs about m log m (sort once and merge once, or append spans that arrive in
// order, as collectedSpans writes them), like the rest of loading a snapshot.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Rga } from '../src/index.ts';

test('marking 20,000 collected spans (a snapshot being loaded) takes well under a second', () => {
  const spans = [];
  // Every other id of one replica: 20,000 disjoint spans, in the order collectedSpans() writes them.
  for (let i = 0; i < 20_000; i++) spans.push({ replica: 'w', counter: 1 + 2 * i, length: 1 });
  const rga = new Rga('r');
  const start = performance.now();
  rga.markCollected(spans);
  const ms = performance.now() - start;
  assert.equal(rga.sizes().collected, 20_000);
  // Linear-ish work is a few ms; on 2a26ec5 this takes several seconds.
  assert.ok(ms < 1000, `markCollected of 20,000 spans took ${Math.round(ms)} ms`);
});
