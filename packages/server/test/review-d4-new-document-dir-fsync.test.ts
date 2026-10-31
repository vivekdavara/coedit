// Review of day 4: with fsync on, a new document's directory is never made durable in its parent, so a power loss
// can take away entries that were appended, fsynced and relayed.
//
// DocumentStore.open() creates `<root>/<doc>` with mkdirSync (and `<root>` itself, recursively, on the first
// document), then fsyncs `<root>/<doc>` after creating its first segment, and append() fsyncs the segment. Nothing
// fsyncs `<root>`, which holds the new directory's entry. Until the file system writes that entry back on its own, a
// power loss can lose the whole directory, though every entry in it was fsynced before the hub relayed it. StoreOptions
// says fsync on is what makes an entry survive "the machine losing power", and fsync covers "each snapshot and
// directory change"; creating the document's directory is a directory change it misses.
//
// Right behaviour: before the first entry of a new document is acknowledged as durable, the directory that holds the
// document's directory (and any directory mkdir created on the way) has been fsynced.
// Fixed: open() syncs the parent of every directory it creates.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { encodeOp } from '@coedit/crdt';
import { DocumentStore } from '../src/store.ts';

test('a new document with fsync on fsyncs the directory its directory was created in', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-review-d4-'));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
  const root = path.join(base, 'data');
  const opened = new Map<number, string>();
  const synced: string[] = [];
  const openSync = fs.openSync;
  const fsyncSync = fs.fsyncSync;
  t.mock.method(fs, 'openSync', (file: fs.PathLike, ...rest: unknown[]) => {
    const fd = (openSync as (...a: unknown[]) => number)(file, ...rest);
    opened.set(fd, path.resolve(String(file)));
    return fd;
  });
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    synced.push(opened.get(fd) ?? `fd ${fd}`);
    fsyncSync(fd);
  });
  const { store } = DocumentStore.open(root, 'doc', { fsync: true });
  store.append(1, [
    encodeOp({ type: 'insert', id: { replica: 'a', counter: 1 }, origin: null, text: 'x' }),
  ]);
  store.close();
  t.mock.restoreAll();
  assert.ok(synced.includes(path.resolve(root, 'doc')), 'the document directory is synced');
  assert.ok(
    synced.includes(path.resolve(root)),
    `the data directory, which holds the new document's entry, is synced (synced: ${synced.join(', ')})`,
  );
});
