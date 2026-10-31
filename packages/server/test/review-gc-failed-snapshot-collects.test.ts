// Review of the tombstone collection (2a26ec5): a snapshot that fails to write still collects, in memory only.
//
// What's wrong: #takeSnapshot calls `this.#rga.collect(keepFrom - 1)` and then `store.snapshot(...)` in the same try;
// when the write fails (the hub logs it and "goes on", as a failed snapshot is meant to lose nothing) the replica has
// already dropped the tombstones, but the disk still has the previous snapshot and the whole log, which rebuild them.
// So the next load of the document (an idle unload, a restart) is a different replica: the collected ids are back as
// tombstones and nothing is collected. Clients that were told in between are now inconsistent with the server:
//   - a client that rebuilt from a snapshot sent in between holds the ids as collected; after the reload the server
//     accepts an insert after one of them (from a client that typed there before it saw the delete), and that
//     client's replica refuses the log entry with CollectedError (which SyncClient's `ops` case doesn't even catch);
//   - a client refused with `resync` in between says hello with `have: 0`; after the reload nothing is collected and
//     the log starts at 1 (no snapshot yet dropped any of it), so it gets the log, not the snapshot it waits for, and
//     stops ("log entries from 1, but 2 were applied").
//
// Right behaviour: a snapshot that isn't written changes nothing in memory (collect only together with a snapshot that
// reached the disk, or treat the failure like a failed append), so a reload rebuilds exactly what the hub held.
// Fixed (see the note before the second test).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Rga, decodeServerMessage, type Op, type ServerMessage } from '@coedit/crdt';
import { DocumentHub, type Member } from '../src/hub.ts';

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-review-gc-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

class Recorder implements Member {
  readonly replica: string;
  readonly messages: ServerMessage[] = [];
  constructor(replica: string) {
    this.replica = replica;
  }
  send(text: string, sent?: () => void): void {
    this.messages.push(decodeServerMessage(text));
    sent?.();
  }
  replace(): void {}
  fail(): void {}
}

const open = (root: string) =>
  new DocumentHub('doc', { store: { root, fsync: false }, snapshotEvery: 4, collect: true });

/**
 * w types "ab" (1, 2), backspaces the b (3: a leaf), types "cdefg" (4-8). The snapshot at 4 lets go of nothing; the
 * one at 8 lets go of up to 4 and collects the b, but its rename fails.
 */
function history(t: TestContext, root: string) {
  const hub = open(root);
  const w = new Recorder('w');
  hub.join(w, 0);
  const rga = new Rga('w');
  const submit = (ops: Op[]) => {
    assert.equal(hub.submit(w, ops), null);
  };
  submit(rga.edit(0, 0, 'a'));
  submit(rga.edit(1, 0, 'b'));
  submit(rga.edit(1, 1, ''));
  for (const c of 'cdef') submit(rga.edit(rga.length, 0, c));
  t.mock.method(console, 'error', () => {});
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (/snapshot-0+8\.jsonl$/.test(String(to))) {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
    rename(from, to);
  });
  submit(rga.edit(rga.length, 0, 'g')); // entry 8: the snapshot that fails
  t.mock.restoreAll();
  return hub;
}

test('a snapshot that fails to write leaves the replica as a reload rebuilds it', (t) => {
  const root = tempDir(t);
  const hub = history(t, root);
  assert.equal(hub.text(), 'acdefg');
  const state = hub.state();
  hub.close();
  const again = open(root);
  // Fails on 2a26ec5: the hub held "collected 2+1@w", the reload has 2@w as a tombstone and nothing collected.
  assert.equal(again.state(), state);
  again.close();
});

// Fixed: the hub collects through Rga.collect(upTo, write), which changes the replica only once the snapshot of it
// after the collection is written; a failed write leaves it as a reload rebuilds it. The review's two follow-on
// cases (a client told something was collected that a reload brings back; a resync whose have-0 hello then gets the
// log) can't arise any more: nothing is collected, so nothing is said to be, and no one is resynced for it.
test('after it, nothing has been said to be collected, and an insert after the element is accepted', (t) => {
  const root = tempDir(t);
  const hub = history(t, root);
  const tab = new Recorder('tab');
  hub.join(tab, 0);
  assert.ok(!tab.messages.some((m) => m.type === 'collected'));
  const late = new Recorder('late');
  hub.join(late, 2);
  const refusal = hub.submit(late, [
    {
      type: 'insert',
      id: { replica: 'late', counter: 3 },
      origin: { replica: 'w', counter: 2 },
      text: '!',
    },
  ]);
  assert.equal(refusal, null);
  hub.close();
});
