// Release review, round 4 (on 88529dc). hub.ts #check and DESIGN.md ("An insert ending more than the capacity past
// the server's clock") argue that the server's clock stays below capacity squared, so it "can't run out before the
// document is full": each accepted insert moves the clock at most a capacity on, and the server holds at most a
// capacity of elements. Collection breaks the second half: collected elements free capacity, so the number of
// inserts is unbounded, and one client can walk every clock up by a capacity per insert, for ever. With the default
// capacity (2^23 - 1) that is about 2^30 one-character inserts, about a million 1,000-op messages, to 2^53 - 1, after
// which no replica can insert again. Since 88529dc a reload keeps the walked-up clock (before, it reset the server's).
//
// Not fixed for v1.0.0: listed under the README's Limitations and in DESIGN.md. This test pins what happens now (the
// clock walks up a capacity per round and a reload keeps it), so the fix (refusing an insert that ends more than a
// capacity past the elements ever accepted, held plus collected) will have to change it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Op } from '@coedit/crdt';
import { DocumentHub, type Member, type Refusal } from '../src/hub.ts';

const member = (replica: string): Member & { failures: Refusal[] } => {
  const failures: Refusal[] = [];
  return {
    replica,
    failures,
    send: (_t, sent) => sent?.(),
    replace() {},
    fail: (r) => failures.push(r),
  };
};

let probes = 0;
/** The hub's clock, read from #check's refusal of an insert far past it (by a throwaway member). */
function clockOf(hub: DocumentHub): number {
  const p = member(`probe${++probes}`);
  hub.join(p, hub.seq);
  const refusal = hub.submit(p, [
    { type: 'insert', id: { replica: p.replica, counter: 2 ** 45 }, origin: null, text: 'x' },
  ]);
  const match = /document's clock \((\d+)\)/.exec(refusal?.message ?? '');
  assert.ok(match, `the probe was refused for its counter: ${JSON.stringify(refusal)}`);
  return Number(match[1]);
}

test("with collection, a client can walk the server's clock up a capacity per insert (a known limitation)", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-r4-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const capacity = 40;
  const options = { store: { root, fsync: false }, snapshotEvery: 2, collect: true, capacity };
  const hub = new DocumentHub('doc', options);
  const m = member('m');
  assert.equal(hub.join(m, 0), null);
  let clock = 0;
  for (let round = 0; round < 100; round++) {
    // Each insert ends exactly a capacity past the server's clock (#check allows it), then is deleted.
    const id = { replica: 'm', counter: clock + capacity };
    const ops: Op[] = [
      { type: 'insert', id, origin: null, text: 'x' },
      { type: 'delete', spans: [{ replica: 'm', counter: id.counter, length: 1 }] },
    ];
    assert.equal(hub.submit(m, ops), null, `round ${round}`);
    clock = id.counter;
  }
  assert.equal(hub.text(), '');
  assert.match(hub.state(), /collected \d+/, 'the tombstones were collected');
  hub.close();
  const again = new DocumentHub('doc', options);
  t.after(() => {
    again.close();
  });
  const reloaded = clockOf(again);
  // 100 rounds of a capacity each, past the capacity-squared bound of 1,600, with an empty document.
  assert.equal(reloaded, 100 * capacity);
  assert.ok(reloaded > capacity * capacity);
});
