// Review of day 4: a snapshot whose pruning fails part way leaves the store's list of segments out of step with the
// disk, and a later snapshot then makes the document unopenable.
//
// DocumentStore.snapshot() takes a segment off its in-memory list (#segments.shift()) BEFORE fs.rmSync removes its
// file. If the rmSync throws (EBUSY, EACCES, EIO...), the hub logs the error and goes on ("a snapshot that fails to
// write loses nothing, so the hub goes on"), but the store has forgotten a segment that is still on disk. The next
// snapshots delete the segments after it, so the forgotten one ends up followed by a segment that doesn't start where
// it ends: open() refuses the whole document ("starts at entry N, but the segment before ended at M"), and the
// server answers every hello for it with server-error from then on.
//
// Right behaviour: a failed prune loses nothing and leaves a directory that opens with every entry, now and after any
// number of later snapshots (forget the segment only once its file is gone, or retry it at the next snapshot).
// Fixed: pruning forgets a segment only once its file is gone, and a failure is logged and retried next time.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Rga, type Op } from '@coedit/crdt';
import { DocumentHub, type Member } from '../src/hub.ts';

test('a segment whose removal failed once does not make the document unopenable later', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-review-d4-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const options = { store: { root, fsync: false }, snapshotEvery: 5 };
  const hub = new DocumentHub('doc', options);
  const member: Member = { replica: 'a', send() {}, replace() {}, fail() {} };
  assert.equal(hub.join(member, 0), null);
  const rga = new Rga('a');
  const type = (n: number) => {
    for (let i = 0; i < n; i++) {
      const ops: Op[] = rga.edit(rga.length, 0, 'x');
      assert.equal(hub.submit(member, ops), null);
    }
  };
  const errors = t.mock.method(console, 'error', () => {});
  type(10); // snapshots after 5 and 10: log-1 pruned at 10; log-6 (6-10) and log-11 (empty) left
  // The snapshot after 15 prunes log-6, and that removal fails once.
  const rmSync = fs.rmSync;
  let failed = 0;
  t.mock.method(fs, 'rmSync', (file: fs.PathLike, ...rest: unknown[]) => {
    if (failed === 0 && String(file).endsWith('log-0000000000000006.jsonl')) {
      failed++;
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    (rmSync as (...a: unknown[]) => void)(file, ...rest);
  });
  type(5);
  assert.equal(failed, 1, 'the removal of log-6 was tried and failed');
  t.mock.restoreAll();
  t.mock.method(console, 'error', () => {});
  type(15); // snapshots after 20, 25 and 30 go through
  assert.ok(errors.mock.callCount() >= 1);
  const text = hub.text();
  const seq = hub.seq;
  hub.close();

  let again: DocumentHub;
  try {
    again = new DocumentHub('doc', options);
  } catch (error) {
    assert.fail(`the document doesn't open again: ${String(error)}`);
  }
  assert.equal(again.text(), text);
  assert.equal(again.seq, seq);
  again.close();
});
