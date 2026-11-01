// What the store fsyncs, and when (review of day 4: removing any of these fsyncs failed no test). The file system
// calls are recorded through mocks: which file each descriptor is, and the order of syncs and renames.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { Rga, encodeOp } from '@coedit/crdt';
import { DocumentHub, type Member } from '../src/hub.ts';
import { DocumentStore, UnsyncedSnapshotError } from '../src/store.ts';

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-fsync-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Records, in order, `sync <file>` for each fsync and `rename <to>` for each rename, from now on. */
function record(t: TestContext): string[] {
  const events: string[] = [];
  const files = new Map<number, string>();
  const openSync = fs.openSync;
  const fsyncSync = fs.fsyncSync;
  const renameSync = fs.renameSync;
  t.mock.method(fs, 'openSync', (file: fs.PathLike, ...rest: unknown[]) => {
    const fd = (openSync as (...a: unknown[]) => number)(file, ...rest);
    files.set(fd, path.basename(String(file)));
    return fd;
  });
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    events.push(`sync ${files.get(fd) ?? '?'}`);
    fsyncSync(fd);
  });
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    events.push(`rename ${path.basename(String(to))}`);
    renameSync(from, to);
  });
  return events;
}

const entry = (counter: number) =>
  encodeOp({
    type: 'insert',
    id: { replica: 'a', counter },
    origin: counter === 1 ? null : { replica: 'a', counter: counter - 1 },
    text: 'x',
  });
const SEGMENT_1 = 'log-0000000000000001.jsonl';

describe('with fsync on', () => {
  test('a new document syncs its first segment into its directory, and each append syncs the segment', (t) => {
    const root = tempDir(t);
    const events = record(t);
    const { store } = DocumentStore.open(path.join(root, 'data'), 'doc', { fsync: true });
    // The parents of the two directories made (data/doc's, then data's), then doc once its first segment exists.
    assert.deepEqual(events, ['sync data', `sync ${path.basename(root)}`, 'sync doc']);
    events.length = 0;
    store.append(1, [entry(1)]);
    store.append(2, [entry(2), entry(3)]);
    assert.deepEqual(events, [`sync ${SEGMENT_1}`, `sync ${SEGMENT_1}`]);
    store.close();
  });

  test('reopening a document syncs its directory before anything is appended (release review)', (t) => {
    // A snapshot whose directory sync failed leaves its file (and a new segment) in place, maybe not durable; the
    // hub then stops, and the next open must make them durable before appending after them.
    const root = tempDir(t);
    const first = DocumentStore.open(root, 'doc', { fsync: true }).store;
    first.append(1, [entry(1)]);
    first.close();
    const events = record(t);
    const { store } = DocumentStore.open(root, 'doc', { fsync: true });
    assert.deepEqual(events, ['sync doc']);
    store.append(2, [entry(2)]);
    assert.deepEqual(events, ['sync doc', `sync ${SEGMENT_1}`]);
    store.close();
  });

  test('a snapshot whose directory sync fails throws UnsyncedSnapshotError and deletes nothing older', (t) => {
    const root = tempDir(t);
    const { store } = DocumentStore.open(root, 'doc', { fsync: true });
    store.append(1, [entry(1)]);
    store.snapshot([entry(1)], 1);
    store.append(2, [entry(2)]);
    const openSync = fs.openSync;
    t.mock.method(fs, 'openSync', (file: fs.PathLike, ...rest: unknown[]) => {
      if (path.basename(String(file)) === 'doc') throw new Error('EIO: i/o error');
      return (openSync as (...a: unknown[]) => number)(file, ...rest);
    });
    t.mock.method(console, 'error', () => {});
    assert.throws(() => {
      store.snapshot([entry(1), entry(2)], 2);
    }, UnsyncedSnapshotError);
    t.mock.restoreAll();
    store.close();
    assert.deepEqual(fs.readdirSync(path.join(root, 'doc')).sort(), [
      SEGMENT_1, // entry 1, before keepFrom: a successful snapshot would have deleted it
      'log-0000000000000002.jsonl',
      'log-0000000000000003.jsonl', // the new segment, started before the directory sync
      'snapshot-0000000000000001.jsonl', // and this
      'snapshot-0000000000000002.jsonl',
    ]);
  });

  test('a snapshot syncs its temporary file before the rename, and the directory after it', (t) => {
    const root = tempDir(t);
    const { store } = DocumentStore.open(root, 'doc', { fsync: true });
    store.append(1, [entry(1)]);
    const events = record(t);
    store.snapshot([entry(1)], 1);
    store.close();
    const name = 'snapshot-0000000000000001.jsonl';
    assert.deepEqual(events, [`sync ${name}.tmp`, `rename ${name}`, 'sync doc', 'sync doc']);
  });

  test('the hub relays an entry only after its segment is synced', (t) => {
    const root = tempDir(t);
    const events = record(t);
    const hub = new DocumentHub('doc', { store: { root } });
    events.length = 0;
    const relayed: string[][] = [];
    const reader: Member = {
      replica: 'r',
      send(text, sent) {
        if (text.startsWith('{"type":"ops"')) relayed.push([...events]);
        sent?.();
      },
      replace() {},
      fail() {},
    };
    const writer: Member = { replica: 'a', send() {}, replace() {}, fail() {} };
    hub.join(reader, 0);
    hub.join(writer, 0);
    assert.equal(hub.submit(writer, new Rga('a').edit(0, 0, 'hi')), null);
    assert.deepEqual(relayed, [[`sync ${SEGMENT_1}`]]);
    hub.close();
  });
});

describe('with fsync off', () => {
  test('nothing is synced', (t) => {
    const root = tempDir(t);
    const events = record(t);
    const { store } = DocumentStore.open(root, 'doc', { fsync: false });
    store.append(1, [entry(1)]);
    store.snapshot([entry(1)], 1);
    store.close();
    assert.deepEqual(events, ['rename snapshot-0000000000000001.jsonl']);
  });
});
