// Release review, round 3 (on 56d26d1). A stored hub forgets, on reload, the counters of elements it collected: its
// clock is rebuilt from the snapshot's held elements (markCollected moves it only for the hub's own replica id). A
// client that saw those counters (its Lamport clock is past them) is honest, yet its next insert can end more than a
// capacity past the reloaded clock, and #check refuses it for good. The re-issue fix (e57064c) keeps the client's old
// clock, so it doesn't help either: the re-issued text fits, the next keystroke doesn't.
//
// Fixed (day 5): markCollected moves the clock past every collected id, anyone's, as receiving the insert did, so a
// reloaded hub's clock is what it was before the reload.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Rga, type Op } from '@coedit/crdt';
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

test("a reloaded hub's clock still covers the counters it collected", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-r3-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const capacity = 40;
  const options = { store: { root, fsync: false }, snapshotEvery: 2, collect: true, capacity };
  const hub = new DocumentHub('doc', options);
  const w = new Rga('w', { capacity: 1000 });
  const y = new Rga('y', { capacity: 1000 });
  const me = new Rga('me', { capacity: 1000 });
  const ww = member('w');
  const yy = member('y');
  hub.join(ww, 0);
  hub.join(yy, 0);
  const log: Op[] = [];
  const submit = (ops: Op[]) => {
    const op = ops[0] as Op;
    const by = op.type === 'insert' ? (op.id.replica === 'w' ? ww : yy) : ww;
    assert.equal(hub.submit(by, ops), null);
    log.push(...ops);
  };
  submit(w.edit(0, 0, 'a'));
  y.apply(log[0] as Op);
  // Four rounds: w pastes 22 characters and deletes them (a leaf), then y types 4 characters (one an entry; y saw
  // only "a", so its counters stay low) so that snapshots let go of the delete and collect the paste.
  for (let round = 0; round < 4; round++) {
    submit(w.edit(1, 0, 'p'.repeat(22)));
    submit(w.edit(1, 22, ''));
    for (let i = 0; i < 4; i++) submit(y.edit(y.length, 0, 'y'));
  }
  for (const op of log) me.apply(op);
  assert.match(hub.state(), /collected 2\+88@w$/, 'the four pastes were collected');
  assert.equal(hub.text(), 'a' + 'y'.repeat(16));
  const clockBefore = me.clock;
  hub.close();

  const again = new DocumentHub('doc', options);
  const m = member('me');
  assert.equal(again.join(m, again.seq), null);
  const refusal = again.submit(m, me.edit(me.length, 0, 'z'));
  assert.equal(
    refusal,
    null,
    `an honest client (clock ${clockBefore}, having applied every entry) types one character after a reload, ` +
      `and the hub refuses it for good: ${JSON.stringify(refusal)}`,
  );
  again.close();
});
