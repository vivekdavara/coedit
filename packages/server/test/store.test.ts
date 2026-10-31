// A document's files (src/store.ts): the log in segments, snapshots, and what opening makes of what a crash left.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { encodeOp, type Op } from '@coedit/crdt';
import { DocumentStore, StoreError, directoryName } from '../src/store.ts';

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-store-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Entry texts for inserts by replica `a`, counters from `from`: what the hub logs. */
const entries = (from: number, n: number): string[] =>
  Array.from({ length: n }, (_, i) =>
    encodeOp({
      type: 'insert',
      id: { replica: 'a', counter: from + i },
      origin: from + i === 1 ? null : { replica: 'a', counter: from + i - 1 },
      text: 'x',
    } satisfies Op),
  );

function open(root: string, doc = 'doc') {
  const opened = DocumentStore.open(root, doc, { fsync: false });
  return { store: opened.store, loaded: opened.loaded };
}

const files = (root: string, doc = 'doc') =>
  fs.readdirSync(path.join(root, directoryName(doc))).sort();
const segment = (first: number) => `log-${String(first).padStart(16, '0')}.jsonl`;
const snapshotFile = (seq: number) => `snapshot-${String(seq).padStart(16, '0')}.jsonl`;

describe('a new document', () => {
  test('opens empty, with a first segment ready for entry 1', (t) => {
    const root = tempDir(t);
    const { store, loaded } = open(root);
    assert.deepEqual(loaded, { snapshot: null, first: 1, entries: [], torn: 0 });
    assert.equal(store.last, 0);
    store.close();
    assert.deepEqual(files(root), [segment(1)]);
  });
});

describe('appending', () => {
  test('reads back every entry, in order, after the store is closed and opened again', (t) => {
    const root = tempDir(t);
    const first = open(root);
    first.store.append(1, entries(1, 3));
    first.store.append(4, entries(4, 2));
    first.store.close();
    const { store, loaded } = open(root);
    assert.deepEqual(loaded.entries, entries(1, 5));
    assert.equal(loaded.first, 1);
    assert.equal(store.last, 5);
    store.append(6, entries(6, 1)); // and goes on where it was
    store.close();
    assert.deepEqual(open(root).loaded.entries, entries(1, 6));
  });

  test('writes one line per entry, {"seq":n,"op":...}', (t) => {
    const root = tempDir(t);
    const { store } = open(root);
    store.append(1, entries(1, 2));
    store.close();
    const text = fs.readFileSync(path.join(root, 'doc', segment(1)), 'utf8');
    assert.equal(
      text,
      entries(1, 2)
        .map((e, i) => `{"seq":${i + 1},"op":${e}}\n`)
        .join(''),
    );
  });

  test('refuses an entry out of sequence, and anything after close', (t) => {
    const { store } = open(tempDir(t));
    assert.throws(() => {
      store.append(2, entries(2, 1));
    }, /entry 2 appended after 0/);
    store.close();
    assert.throws(() => {
      store.append(1, entries(1, 1));
    }, /closed/);
  });
});

describe('what a crash leaves', () => {
  // An append cut off part way: some whole lines, then part of one.
  for (const [what, tail] of [
    ['half a line', '{"seq":3,"op":{"type":"ins'],
    ['a line without its newline', `{"seq":3,"op":${entries(3, 1)[0]}}`],
    ['a code point cut in two', Buffer.from('{"seq":3,"op":{"text":"😀', 'utf8').subarray(0, -2)],
  ] as const) {
    test(`drops ${what} at the end of the last segment, and truncates the file there`, (t) => {
      const root = tempDir(t);
      const first = open(root);
      first.store.append(1, entries(1, 2));
      first.store.close();
      const file = path.join(root, 'doc', segment(1));
      const size = fs.statSync(file).size;
      fs.appendFileSync(file, tail);
      const { store, loaded } = open(root);
      assert.deepEqual(loaded.entries, entries(1, 2));
      assert.equal(loaded.torn, Buffer.byteLength(tail));
      assert.equal(fs.statSync(file).size, size);
      store.append(3, entries(3, 1));
      store.close();
      assert.deepEqual(open(root).loaded.entries, entries(1, 3));
    });
  }

  test('removes a snapshot that was being written', (t) => {
    const root = tempDir(t);
    open(root).store.close();
    fs.writeFileSync(path.join(root, 'doc', `${snapshotFile(9)}.tmp`), '{"seq":9,"ops":1}\n{"ty');
    const { store, loaded } = open(root);
    store.close();
    assert.equal(loaded.snapshot, null);
    assert.deepEqual(files(root), [segment(1)]);
  });
});

describe('a document that does not read back is refused', () => {
  /** Writes entries 1 to 3, lets `damage` change the files, and expects the open to fail with `problem`. */
  function refused(t: TestContext, damage: (dir: string) => void, problem: RegExp): void {
    const root = tempDir(t);
    const first = open(root);
    first.store.append(1, entries(1, 3));
    first.store.close();
    damage(path.join(root, 'doc'));
    assert.throws(
      () => open(root),
      (error: unknown) => {
        assert.ok(error instanceof StoreError, String(error));
        assert.match(error.message, problem);
        return true;
      },
    );
  }
  const rewrite = (dir: string, edit: (text: string) => string) => {
    const file = path.join(dir, segment(1));
    fs.writeFileSync(file, edit(fs.readFileSync(file, 'utf8')));
  };

  test('a damaged line before the end', (t) => {
    refused(
      t,
      (dir) => {
        rewrite(dir, (s) => s.replace('{"seq":2', '{"seq":2x'));
      },
      /line 2/,
    );
  });
  test('an entry numbered out of order', (t) => {
    refused(
      t,
      (dir) => {
        rewrite(dir, (s) => s.replace('{"seq":2', '{"seq":7'));
      },
      /entry 7 where 2/,
    );
  });
  test('an extra key, or a line that is not an entry', (t) => {
    refused(
      t,
      (dir) => {
        rewrite(dir, (s) => s.replace('{"seq":2,', '{"seq":2,"x":1,'));
      },
      /line 2/,
    );
    refused(
      t,
      (dir) => {
        rewrite(dir, (s) => s.replace(/\{"seq":2,.*\n/, '[2]\n'));
      },
      /line 2/,
    );
  });
  test('an operation the wire format refuses', (t) => {
    refused(
      t,
      (dir) => {
        rewrite(dir, (s) => s.replace('"counter":2}', '"counter":0}'));
      },
      /line 2/,
    );
  });
  test('an empty line', (t) => {
    refused(
      t,
      (dir) => {
        rewrite(dir, (s) => s.replace('\n', '\n\n'));
      },
      /line 2/,
    );
  });
  test('bytes that are not UTF-8', (t) => {
    refused(
      t,
      (dir) => {
        fs.appendFileSync(path.join(dir, segment(1)), Buffer.from([0xff, 0x0a]));
      },
      /not UTF-8/,
    );
  });
  test('a gap between segments, an unfinished line in an earlier one, a log not starting at 1', (t) => {
    refused(
      t,
      (dir) => {
        fs.writeFileSync(path.join(dir, segment(5)), '');
      },
      /starts at entry 5/,
    );
    refused(
      t,
      (dir) => {
        fs.appendFileSync(path.join(dir, segment(1)), '{"seq":4');
        fs.writeFileSync(path.join(dir, segment(4)), '');
      },
      /isn't the last segment/,
    );
    refused(
      t,
      (dir) => {
        fs.rmSync(path.join(dir, segment(1)));
        fs.writeFileSync(path.join(dir, segment(4)), '');
      },
      /no snapshot, and the log starts at entry 4, not 1/,
    );
  });
});

describe('snapshots', () => {
  test('start a new segment, and drop the snapshots and segments before keepFrom', (t) => {
    const root = tempDir(t);
    const { store } = open(root);
    store.append(1, entries(1, 5));
    store.snapshot(entries(1, 5), 1);
    assert.deepEqual(files(root), [segment(1), segment(6), snapshotFile(5)]);
    store.append(6, entries(6, 3));
    store.snapshot(entries(1, 8), 6); // keep the entries since the previous snapshot
    assert.deepEqual(files(root), [segment(6), segment(9), snapshotFile(8)]);
    store.append(9, entries(9, 1));
    store.close();

    const { store: again, loaded } = open(root);
    again.close();
    assert.deepEqual(loaded.snapshot, { seq: 8, ops: entries(1, 8) });
    assert.equal(loaded.first, 6);
    assert.deepEqual(loaded.entries, entries(6, 4));
  });

  test('a snapshot taken right after another keeps the same empty segment', (t) => {
    const root = tempDir(t);
    const { store } = open(root);
    store.append(1, entries(1, 2));
    store.snapshot(entries(1, 2), 1);
    store.snapshot(entries(1, 2), 1);
    store.close();
    assert.deepEqual(files(root), [segment(1), segment(3), snapshotFile(2)]);
  });

  test('of an empty document, and with no log left at all, open again', (t) => {
    const root = tempDir(t);
    const { store } = open(root);
    store.snapshot([], 1);
    store.close();
    const { store: again, loaded } = open(root);
    again.close();
    assert.deepEqual(loaded, { snapshot: { seq: 0, ops: [] }, first: 1, entries: [], torn: 0 });
  });

  test('a snapshot that does not read back, or a log that ends before it, is refused', (t) => {
    const root = tempDir(t);
    const { store } = open(root);
    store.append(1, entries(1, 3));
    store.snapshot(entries(1, 3), 1);
    store.close();
    const file = path.join(root, 'doc', snapshotFile(3));
    const good = fs.readFileSync(file, 'utf8');
    for (const [bad, problem] of [
      [good.replace('"ops":3', '"ops":4'), /holds 3 operations, but its header says 4/],
      [good.replace('{"seq":3,', '{"seq":2,'), /after entry 2, not 3/],
      [good.slice(0, -1), /unfinished line/],
      [good.replace('"counter":2}', '"counter":0}'), /line 3/],
    ] as const) {
      fs.writeFileSync(file, bad);
      assert.throws(() => open(root), problem);
    }
    fs.writeFileSync(file, good);
    fs.rmSync(path.join(root, 'doc', segment(1)));
    fs.writeFileSync(path.join(root, 'doc', segment(4)), '');
    assert.doesNotThrow(() => {
      open(root).store.close();
    });
    fs.renameSync(path.join(root, 'doc', segment(4)), path.join(root, 'doc', segment(5)));
    assert.throws(() => open(root), /log holds entries 5 to 4/);
  });
});

describe('directory names', () => {
  test('keep documents whose names differ only in case apart, on a file system that ignores case', (t) => {
    const root = tempDir(t);
    const upper = open(root, 'Notes');
    upper.store.append(1, entries(1, 1));
    upper.store.close();
    const lower = open(root, 'notes');
    lower.store.close();
    assert.deepEqual(lower.loaded.entries, []);
    assert.deepEqual(fs.readdirSync(root).sort(), ['^notes', 'notes']);
    assert.equal(directoryName('aB-c_D9'), 'a^b-c_^d9');
  });
});
