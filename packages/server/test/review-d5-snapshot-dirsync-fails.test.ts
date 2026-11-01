// Release review (d5) of fed7dba: "a failed snapshot write leaves memory and disk as they were" holds only for
// failures before the rename. DocumentStore.snapshot renames the snapshot into place and then calls
// syncDirectory(dir) outside any try (with fsync on, the default); when that throws (EMFILE opening the directory on
// a server near its descriptor limit, EIO), the collecting snapshot IS on disk, but store.snapshot throws, so
// Rga.collect's write throws and the replica keeps the tombstones the disk now says are collected. The hub logs a
// failed snapshot and goes on accepting operations that name those tombstones; the next load (idle unload, restart)
// replays such an entry onto the snapshot that collected its origin and refuses to load the document at all.
//
// Fixed: the store throws UnsyncedSnapshotError for a failure after the rename, and the hub fails as for a failed
// append (members closed with server-error, the next join loads from disk); every open syncs the directory, so what
// the reload found is durable before anything is appended after it. The tests below were the review's (the reload
// differed from the hub's replica; the document no longer loaded) and now check the fixed behaviour.
//
// History (as review-gc-failed-snapshot-collects): w types "ab" (1, 2), backspaces the b (3: a leaf), types "cdef"
// (4-7) and "g" (8). The snapshot at 8 collects the b; its rename succeeds and the directory fsync after it fails.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Rga, decodeServerMessage, type Op, type ServerMessage } from '@coedit/crdt';
import { DocumentHub, type Member } from '../src/hub.ts';

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-review-d5-'));
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
  new DocumentHub('doc', { store: { root, fsync: true }, snapshotEvery: 4, collect: true });

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
  const openSync = fs.openSync;
  let renamedInto: string | null = null;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    rename(from, to);
    if (/snapshot-0+8\.jsonl$/.test(String(to))) renamedInto = path.dirname(String(to));
  });
  t.mock.method(fs, 'openSync', (file: fs.PathLike, ...rest: unknown[]) => {
    if (renamedInto !== null && String(file) === renamedInto) {
      renamedInto = null;
      throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    }
    return (openSync as (...a: unknown[]) => number)(file, ...rest);
  });
  // Entry 8: stored and relayed, then the snapshot whose directory fsync fails.
  const failure = hub.submit(w, rga.edit(rga.length, 0, 'g'));
  t.mock.restoreAll();
  assert.equal(failure?.code, 'server-error', 'the sender is told to reconnect');
  assert.equal(
    hub.broken,
    true,
    'the hub stops instead of serving a replica the disk disagrees with',
  );
  assert.equal(
    w.messages.filter((m) => m.type === 'ops').length,
    8,
    'entry 8 was relayed before the snapshot',
  );
  return hub;
}

test('a snapshot whose directory fsync fails after the rename stops the hub; the reload is what is on disk', (t) => {
  const root = tempDir(t);
  const hub = history(t, root);
  const late = new Recorder('late');
  assert.equal(hub.join(late, 0)?.code, 'server-error', 'a broken hub takes no one');
  hub.close();
  const again = open(root);
  assert.equal(again.seq, 8);
  assert.equal(again.text(), 'acdefg');
  assert.match(again.state(), /collected 2\+1@w/, 'the snapshot on disk collected the b');
  again.close();
});

test('after such a snapshot the document loads, and an insert after the collected b gets resync', (t) => {
  const root = tempDir(t);
  history(t, root).close();
  const hub = open(root);
  const late = new Recorder('late');
  hub.join(late, 2);
  // late typed "!" after the b before it saw the backspace: the b is collected, so it must rejoin.
  const refusal = hub.submit(late, [
    {
      type: 'insert',
      id: { replica: 'late', counter: 3 },
      origin: { replica: 'w', counter: 2 },
      text: '!',
    },
  ]);
  assert.equal(refusal?.code, 'resync');
  hub.close();
  let again: DocumentHub;
  try {
    again = open(root);
  } catch (error) {
    assert.fail(`the document no longer loads: ${(error as Error).message}`);
  }
  assert.equal(again.text(), 'acdefg');
  again.close();
});
