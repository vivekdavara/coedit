// A hub with a store (DESIGN.md "Persistence (day 4)"): what it logs is on disk before anyone sees it, a new hub on
// the same directory is the same document, snapshots replace old log entries for clients too far behind, and a
// failed write closes the hub rather than let the disk and the replica disagree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { Rga, decodeServerMessage, type InsertOp, type Op, type ServerMessage } from '@coedit/crdt';
import { DocumentHub, type HubOptions, type Member, type Refusal } from '../src/hub.ts';
import { directoryName } from '../src/store.ts';

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-hub-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * A member that applies what it receives to its own replica, as the sync client does: log entries in order, then
 * a snapshot merged in when one comes. `onSend` runs before each message is handled.
 */
class ReplicaMember implements Member {
  readonly replica: string;
  readonly rga: Rga;
  readonly messages: ServerMessage[] = [];
  seq: number;
  failed: Refusal | null = null;
  onSend: ((text: string) => void) | null = null;

  constructor(replica: string, have = 0, rga = new Rga(replica)) {
    this.replica = replica;
    this.seq = have;
    this.rga = rga;
  }

  send(text: string, sent?: () => void): void {
    this.onSend?.(text);
    const message = decodeServerMessage(text);
    this.messages.push(message);
    if (message.type === 'ops') {
      assert.equal(message.from, this.seq + 1, 'log entries arrive in order');
      for (const op of message.ops) this.rga.apply(op);
      this.seq += message.ops.length;
    } else if (message.type === 'snapshot') {
      assert.ok(message.seq >= this.seq, 'a snapshot never takes a member back');
      for (const op of message.ops) this.rga.apply(op);
      if (message.last) this.seq = message.seq;
    }
    sent?.();
  }

  replace(): void {}

  fail(refusal: Refusal): void {
    this.failed = refusal;
  }

  types(): string[] {
    return this.messages.map((m) => m.type);
  }
}

/** A hub on `root` that fsyncs nothing (the tests don't lose power). */
const hub = (root: string, options: HubOptions = {}) =>
  new DocumentHub('doc', { store: { root, fsync: false }, ...options });

/** A member's edit at `index`, submitted; returns the operations. */
function type(h: DocumentHub, m: ReplicaMember, index: number, del: number, text: string): Op[] {
  const ops = m.rga.edit(index, del, text);
  assert.equal(h.submit(m, ops), null);
  return ops;
}

function segmentText(root: string): string {
  const dir = path.join(root, directoryName('doc'));
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith('log-'))
    .sort()
    .map((n) => fs.readFileSync(path.join(dir, n), 'utf8'))
    .join('');
}

describe('a stored document', () => {
  test('is on disk before any member gets the relay', (t) => {
    const root = tempDir(t);
    const h = hub(root);
    const a = new ReplicaMember('a');
    const b = new ReplicaMember('b');
    h.join(a, 0);
    h.join(b, 0);
    const seen: string[] = [];
    b.onSend = (text) => {
      if (text.startsWith('{"type":"ops"')) seen.push(segmentText(root));
    };
    type(h, a, 0, 0, 'hi');
    assert.equal(seen.length, 1);
    assert.match(seen[0] as string, /^\{"seq":1,"op":\{"type":"insert".*"text":"hi"\}\}\n$/);
    h.close();
  });

  test('comes back the same in a new hub: text, state, log, and catch-up from any have', (t) => {
    const root = tempDir(t);
    const first = hub(root);
    const a = new ReplicaMember('a');
    first.join(a, 0);
    type(first, a, 0, 0, 'hello world');
    type(first, a, 5, 6, '');
    type(first, a, 5, 0, ', there');
    first.close();

    const second = hub(root);
    assert.equal(second.seq, 3);
    assert.equal(second.text(), 'hello, there');
    assert.equal(second.state(), first.state());
    // The log as the new hub sends it from the start.
    const replay = new ReplicaMember('r');
    second.join(replay, 0);
    const ops = replay.messages.flatMap((m) => (m.type === 'ops' ? m.ops : []));
    assert.equal(ops.length, 3);
    for (let have = 0; have <= 3; have++) {
      // A member that had applied `have` entries before the restart.
      const late = new ReplicaMember(`m${have}`);
      for (const op of ops.slice(0, have)) late.rga.apply(op);
      late.seq = have;
      assert.equal(second.join(late, have), null);
      assert.equal(late.seq, 3);
      assert.equal(late.rga.state(), second.state());
    }
    second.close();
  });

  test("goes on numbering after a new hub opens it, and the next one reads both hubs' entries", (t) => {
    const root = tempDir(t);
    const a = new ReplicaMember('a');
    const first = hub(root);
    first.join(a, 0);
    type(first, a, 0, 0, 'ab');
    first.close();
    const second = hub(root);
    second.join(a, 1);
    type(second, a, 2, 0, 'cd');
    assert.equal(second.seq, 2);
    second.close();
    const third = hub(root);
    assert.equal(third.text(), 'abcd');
    assert.equal(third.state(), a.rga.state());
    third.close();
  });
});

describe('snapshots in a hub', () => {
  /** A hub snapshotting every 5 entries, with `n` one-character inserts by member a, each its own entry. */
  function filled(root: string, n: number): { h: DocumentHub; a: ReplicaMember; log: Op[] } {
    const h = hub(root, { snapshotEvery: 5 });
    const a = new ReplicaMember('a');
    h.join(a, 0);
    const log: Op[] = [];
    for (let i = 0; i < n; i++) log.push(...type(h, a, i, 0, String.fromCodePoint(97 + (i % 26))));
    return { h, a, log };
  }

  test('keep the log from the previous snapshot on, in memory and on disk', (t) => {
    const root = tempDir(t);
    const { h } = filled(root, 12); // snapshots after 5 and 10
    assert.equal(h.seq, 12);
    assert.equal(h.base, 5);
    const dir = path.join(root, directoryName('doc'));
    assert.deepEqual(fs.readdirSync(dir).sort(), [
      'log-0000000000000006.jsonl',
      'log-0000000000000011.jsonl',
      'snapshot-0000000000000010.jsonl',
    ]);
    h.close();
    const again = hub(root, { snapshotEvery: 5 });
    assert.equal(again.base, 5);
    assert.equal(again.seq, 12);
    assert.equal(again.state(), h.state());
    again.close();
  });

  test('go to a member whose have is older than the log kept, then the log from there', (t) => {
    const root = tempDir(t);
    const { h, a, log } = filled(root, 12);
    // Entries 1 to 3 applied before it went away: older than the log kept (from 6).
    const behind = new ReplicaMember('b', 3);
    for (const op of log.slice(0, 3)) behind.rga.apply(op);
    assert.equal(h.join(behind, 3), null);
    assert.deepEqual(behind.types(), ['welcome', 'snapshot']);
    assert.equal(behind.seq, 12);
    assert.equal(behind.rga.state(), h.state());
    // Live after it.
    type(h, a, 0, 1, '');
    assert.equal(behind.seq, 13);
    assert.equal(behind.rga.state(), h.state());
    h.close();
  });

  test('do not go to a member the log kept can bring up to date', (t) => {
    const root = tempDir(t);
    const { h } = filled(root, 12);
    for (const have of [5, 9, 12]) {
      const m = new ReplicaMember(`m${have}`, have);
      h.join(m, have);
      assert.ok(!m.types().includes('snapshot'), `have ${have}: ${m.types().join(' ')}`);
    }
    h.close();
  });

  test('of a long document take several messages, the last marked last, each within the message limit', (t) => {
    const root = tempDir(t);
    const h = hub(root, { snapshotEvery: 1000 });
    const a = new ReplicaMember('a');
    h.join(a, 0);
    // 3,000 runs: more than one message's 1,000 operations.
    for (let i = 0; i < 3000; i++) type(h, a, 0, 0, 'z');
    const b = new ReplicaMember('b');
    const sizes: number[] = [];
    b.onSend = (text) => sizes.push(Buffer.byteLength(text));
    h.join(b, 0);
    const parts = b.messages.filter((m) => m.type === 'snapshot');
    assert.equal(parts.length, 3);
    assert.deepEqual(
      parts.map((m) => m.last),
      [false, false, true],
    );
    assert.ok(sizes.every((s) => s <= 1 << 20));
    assert.equal(b.rga.state(), h.state());
    h.close();
  });

  test("don't drop log entries a member still catching up hasn't been sent", (t) => {
    const root = tempDir(t);
    const h = hub(root, { snapshotEvery: 5 });
    const a = new ReplicaMember('a');
    h.join(a, 0);
    for (let i = 0; i < 4; i++) type(h, a, i, 0, 'q');
    // A member that never finishes reading its first catch-up batch.
    const stuck: Member = { replica: 's', send() {}, replace() {}, fail() {} };
    h.join(stuck, 0);
    for (let i = 4; i < 16; i++) type(h, a, i, 0, 'q'); // snapshots after 5, 10, 15
    // Its first batch (entries 1 to 4) is in flight; it still needs everything from 5 on.
    assert.equal(h.base, 4);
    h.leave(stuck);
    for (let i = 16; i < 20; i++) type(h, a, i, 0, 'q'); // snapshot after 20
    assert.equal(h.base, 15);
    h.close();
  });
});

describe('a failed write', () => {
  test('closes every member with server-error; the next hub has only what reached the disk', (t) => {
    const root = tempDir(t);
    const h = hub(root);
    const a = new ReplicaMember('a');
    const b = new ReplicaMember('b');
    h.join(a, 0);
    h.join(b, 0);
    type(h, a, 0, 0, 'kept');
    const relayed = b.messages.length;
    t.mock.method(fs, 'writeSync', () => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    const lost = a.rga.edit(4, 0, '!');
    const refusal = h.submit(a, lost);
    t.mock.restoreAll();
    assert.equal(refusal?.code, 'server-error');
    assert.equal(b.failed?.code, 'server-error');
    assert.equal(b.messages.length, relayed, 'nothing that failed to store was relayed');
    assert.ok(h.broken);
    assert.equal(h.members, 0, 'nobody is left joined to it');
    assert.equal(h.join(new ReplicaMember('c'), 0)?.code, 'server-error');
    assert.equal(h.submit(a, lost)?.code, 'server-error');

    const again = hub(root);
    assert.equal(again.text(), 'kept');
    assert.equal(again.seq, 1);
    // a resends its outbox on reconnect: the operation the failed write lost is logged now.
    again.join(a, 1);
    assert.equal(again.submit(a, lost), null);
    assert.equal(again.text(), 'kept!');
    again.close();
  });

  test('cut off part way leaves a torn line the next hub drops', (t) => {
    const root = tempDir(t);
    const h = hub(root);
    const a = new ReplicaMember('a');
    h.join(a, 0);
    type(h, a, 0, 0, 'ab');
    const write = fs.writeSync;
    t.mock.method(fs, 'writeSync', (fd: number, bytes: Buffer, offset: number, length: number) => {
      // Half of it reaches the file, then the disk is full.
      write(fd, bytes, offset, Math.floor(length / 2));
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    assert.equal(h.submit(a, a.rga.edit(2, 0, 'cd'))?.code, 'server-error');
    t.mock.restoreAll();
    const again = hub(root);
    assert.equal(again.text(), 'ab');
    again.close();
  });
});

describe('a document whose files do not rebuild', () => {
  test('is refused when the hub is created', (t) => {
    const root = tempDir(t);
    const h = hub(root);
    const a = new ReplicaMember('a');
    h.join(a, 0);
    type(h, a, 0, 0, 'ab');
    h.close();
    // Entry 1 rewritten to name an origin the document doesn't hold: it reads back, but can't be placed.
    const file = path.join(root, directoryName('doc'), 'log-0000000000000001.jsonl');
    const bad: InsertOp = {
      type: 'insert',
      id: { replica: 'a', counter: 2 },
      origin: { replica: 'z', counter: 1 },
      text: 'ab',
    };
    fs.writeFileSync(file, `{"seq":1,"op":${JSON.stringify(bad)}}\n`);
    const fds = fs.readdirSync('/dev/fd').length;
    assert.throws(() => hub(root), /dependencies aren't in the document/);
    assert.equal(fs.readdirSync('/dev/fd').length, fds, "the refused document's store is closed");
  });

  test('is refused when its snapshot leaves an operation waiting', (t) => {
    const root = tempDir(t);
    const dir = path.join(root, directoryName('doc'));
    fs.mkdirSync(dir);
    const waiting: InsertOp = {
      type: 'insert',
      id: { replica: 'a', counter: 2 },
      origin: { replica: 'a', counter: 1 },
      text: 'b',
    };
    fs.writeFileSync(
      path.join(dir, 'snapshot-0000000000000001.jsonl'),
      `{"seq":1,"ops":1}\n${JSON.stringify(waiting)}\n`,
    );
    fs.writeFileSync(path.join(dir, 'log-0000000000000002.jsonl'), '');
    assert.throws(() => hub(root), /leave some waiting/);
  });
});
