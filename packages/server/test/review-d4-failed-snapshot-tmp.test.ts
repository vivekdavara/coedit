// Review of day 4: a snapshot that fails to write leaves its temporary file behind, and the hub tries again on every
// operation after it, so a failure that lasts piles up a whole snapshot's copy on disk per operation.
//
// DocumentStore.snapshot() writes `snapshot-<seq>.jsonl.tmp` and renames it into place; if a step after creating the
// temporary file throws (the write, the fsync, the rename), the file stays until the document is next opened. The hub
// catches the error and goes on ("a snapshot that fails to write loses nothing"), but leaves #snapshotSeq where it
// was, so `seq - #snapshotSeq >= snapshotEvery` holds for every later submit: each one writes the whole document
// again under a new name (the seq moved on) and fails the same way. A document of 1 MB with a rename that keeps
// failing gains 1 MB of temporary files per keystroke, until the disk is full and appends fail too.
//
// Right behaviour: a failed snapshot removes its temporary file, and isn't retried on every operation (at most one
// temporary file exists at a time, and a failing snapshot isn't rewritten per keystroke). Fixed: the temporary file is
// removed on failure, and the hub tries again an interval later (the reviewer's bound was 2 attempts; with one attempt
// per interval of 10 it's 3: at entries 10, 20 and 30).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Rga } from '@coedit/crdt';
import { DocumentHub, type Member } from '../src/hub.ts';
import { directoryName } from '../src/store.ts';

test('a snapshot whose rename keeps failing does not leave a temporary file per operation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-review-d4-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const hub = new DocumentHub('doc', { store: { root, fsync: false }, snapshotEvery: 10 });
  const member: Member = { replica: 'a', send() {}, replace() {}, fail() {} };
  assert.equal(hub.join(member, 0), null);
  const rga = new Rga('a');
  t.mock.method(console, 'error', () => {});
  const renames = t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  });
  for (let i = 0; i < 30; i++) assert.equal(hub.submit(member, rga.edit(rga.length, 0, 'x')), null);
  const dir = path.join(root, directoryName('doc'));
  const tmp = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
  hub.close();
  t.mock.restoreAll();
  // Entries 10 to 30 each tried a whole snapshot, and each attempt left its temporary file.
  const found = `${renames.mock.callCount()} snapshot attempts for 30 entries, ${tmp.length} temporary files left`;
  assert.equal(tmp.length, 0, found);
  assert.equal(renames.mock.callCount(), 3, found);
});
