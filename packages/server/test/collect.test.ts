// Tombstone collection in a stored hub (DESIGN.md "Tombstones"): at each snapshot the hub collects the leaf
// tombstones whose last delete is in an entry the snapshot lets go of, keeps the collected ids in the snapshot, sends
// them to a client rebuilding from a snapshot, and answers an operation naming one with `resync`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { Rga, decodeServerMessage, type Op, type ServerMessage } from '@coedit/crdt';
import { DocumentHub, type Member } from '../src/hub.ts';

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-collect-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A member that keeps every message, and builds a replica from a snapshot the way the sync client does. */
class Rebuilder implements Member {
  readonly replica: string;
  readonly messages: ServerMessage[] = [];
  rga: Rga | null = null;
  #building: Rga | null = null;
  #collected: { replica: string; counter: number; length: number }[] = [];

  constructor(replica: string) {
    this.replica = replica;
  }

  send(text: string, sent?: () => void): void {
    const m = decodeServerMessage(text);
    this.messages.push(m);
    if (m.type === 'collected') this.#collected.push(...m.spans);
    if (m.type === 'snapshot') {
      if (this.#building === null) {
        this.#building = new Rga(this.replica);
        this.#building.markCollected(this.#collected);
      }
      for (const op of m.ops) this.#building.apply(op);
      if (m.last) {
        this.rga = this.#building;
        this.#building = null;
      }
    }
    if (m.type === 'ops' && this.rga !== null) for (const op of m.ops) this.rga.apply(op);
    sent?.();
  }

  replace(): void {}

  fail(): void {}
}

const quiet: Member = { replica: 'w', send() {}, replace() {}, fail() {} };

/**
 * A stored hub (a snapshot every 4 entries) where writer `w` types "abcdefgh" one character an entry, backspaces the
 * "h" (entry 9: a typo, so "h" is a leaf: the next character typed goes after "g"), then types "1234567": snapshots
 * after 4, 8, 12 and 16, and the one after 16 lets go of entries up to 12, the backspace included.
 */
function hubWithTypo(root: string, last = '1234567') {
  const hub = new DocumentHub('doc', {
    store: { root, fsync: false },
    snapshotEvery: 4,
    collect: true,
  });
  const w = new Rga('w');
  hub.join(quiet, 0);
  const submit = (ops: Op[]) => {
    assert.equal(hub.submit(quiet, ops), null);
  };
  for (const c of 'abcdefgh') submit(w.edit(w.length, 0, c));
  submit(w.edit(7, 1, ''));
  for (const c of last) submit(w.edit(w.length, 0, c));
  return { hub, w, submit };
}

describe('collection in a stored hub', () => {
  test('takes a leaf tombstone once the snapshot lets go of its delete, and not before', (t) => {
    const root = tempDir(t);
    const { hub, w, submit } = hubWithTypo(root, '123');
    assert.equal(hub.seq, 12);
    assert.doesNotMatch(hub.state(), /collected/, 'entry 9 is still kept after the snapshot at 12');
    for (const c of '4567') submit(w.edit(w.length, 0, c));
    assert.match(hub.state(), /collected 8\+1@w$/);
    assert.equal(hub.text(), 'abcdefg1234567');
    hub.close();
  });

  test('does not take a deleted stretch that later text was typed after (not a leaf)', (t) => {
    const root = tempDir(t);
    const hub = new DocumentHub('doc', {
      store: { root, fsync: false },
      snapshotEvery: 4,
      collect: true,
    });
    const w = new Rga('w');
    hub.join(quiet, 0);
    for (const c of 'abcdefgh') hub.submit(quiet, w.edit(w.length, 0, c));
    hub.submit(quiet, w.edit(2, 2, '')); // "cd": d is c's child, and e is d's
    for (let i = 0; i < 40; i++) hub.submit(quiet, w.edit(w.length, 0, 'x'));
    assert.doesNotMatch(hub.state(), /collected/);
    assert.match(hub.state(), /3@w<2@w~"c" 4@w<3@w~"d"/);
    hub.close();
  });

  test('keeps the collected ids in the snapshot, and a reload is the same document', (t) => {
    const root = tempDir(t);
    const { hub } = hubWithTypo(root);
    const state = hub.state();
    assert.match(state, /collected/);
    hub.close();
    const again = new DocumentHub('doc', {
      store: { root, fsync: false },
      snapshotEvery: 4,
      collect: true,
    });
    assert.equal(again.state(), state);
    again.close();
  });

  test('sends a client rebuilding from a snapshot the collected ids first, and it ends with the same state', (t) => {
    const root = tempDir(t);
    const { hub } = hubWithTypo(root);
    const fresh = new Rebuilder('f');
    assert.equal(hub.join(fresh, 0), null);
    assert.deepEqual(
      fresh.messages.map((m) => m.type),
      ['welcome', 'collected', 'snapshot'],
    );
    assert.equal(fresh.rga?.state(), hub.state());
    hub.close();
  });

  test('answers an operation naming a collected element with resync, changing nothing', (t) => {
    const root = tempDir(t);
    const { hub } = hubWithTypo(root);
    const before = hub.state();
    const seq = hub.seq;
    // A client that typed after the "h", or deleted it, before it saw the backspace.
    const late: Member = { replica: 'x', send() {}, replace() {}, fail() {} };
    hub.join(late, seq);
    const afterH: Op = {
      type: 'insert',
      id: { replica: 'x', counter: 9 },
      origin: { replica: 'w', counter: 8 },
      text: '!',
    };
    const deleteH: Op = { type: 'delete', spans: [{ replica: 'w', counter: 8, length: 1 }] };
    for (const op of [afterH, deleteH]) {
      const refusal = hub.submit(late, [op]);
      assert.equal(refusal?.code, 'resync');
      assert.match(refusal.message, /collected/);
      assert.equal(hub.state(), before);
      assert.equal(hub.seq, seq);
    }
    hub.close();
  });

  test('keeps a tombstone a later entry deletes again until that entry is let go of too', (t) => {
    const root = tempDir(t);
    const hub = new DocumentHub('doc', {
      store: { root, fsync: false },
      snapshotEvery: 4,
      collect: true,
    });
    const w = new Rga('w');
    hub.join(quiet, 0);
    for (const c of 'abcd') hub.submit(quiet, w.edit(w.length, 0, c)); // 1-4
    const del = w.edit(3, 1, ''); // backspaces d: a leaf
    hub.submit(quiet, del); // 5
    for (const c of 'efg') hub.submit(quiet, w.edit(w.length, 0, c)); // 6-8
    hub.submit(quiet, del); // 9: the same delete again (a resend), logged again
    for (const c of 'hij') hub.submit(quiet, w.edit(w.length, 0, c)); // 10-12: the snapshot lets go of up to 8
    assert.doesNotMatch(hub.state(), /collected/, 'the delete at 9 names it, and 9 is kept');
    for (const c of 'klmn') hub.submit(quiet, w.edit(w.length, 0, c)); // 16: lets go of up to 12
    assert.match(hub.state(), /collected 4\+1@w$/);
    const state = hub.state();
    hub.close();
    // And the reload replays nothing that names it.
    const again = new DocumentHub('doc', {
      store: { root, fsync: false },
      snapshotEvery: 4,
      collect: true,
    });
    assert.equal(again.state(), state);
    again.close();
  });

  // Review of the collection: the stamps a reload gives, and a member catching up, were never checked.
  const open = (root: string) =>
    new DocumentHub('doc', { store: { root, fsync: false }, snapshotEvery: 4, collect: true });

  test('a reload stamps the tombstones in its snapshot with its sequence number, so they are collected later', (t) => {
    const root = tempDir(t);
    const hub = open(root);
    const w = new Rga('w');
    hub.join(quiet, 0);
    for (const c of 'abcde') hub.submit(quiet, w.edit(w.length, 0, c)); // 1-5
    hub.submit(quiet, w.edit(4, 1, '')); // 6: backspaces e
    for (const c of 'fg') hub.submit(quiet, w.edit(w.length, 0, c)); // 7-8: the snapshot at 8 lets go of 1-4
    assert.doesNotMatch(hub.state(), /collected/);
    hub.close();
    const again = open(root); // the snapshot at 8 holds e as a tombstone
    again.join(quiet, again.seq);
    for (const c of 'hijk') again.submit(quiet, w.edit(w.length, 0, c)); // to 12: lets go of 5-8
    assert.match(again.state(), /collected 5\+1@w$/);
    again.close();
  });

  test('a reload stamps the entries it replays after its snapshot with their own numbers', (t) => {
    const root = tempDir(t);
    const hub = open(root);
    const w = new Rga('w');
    hub.join(quiet, 0);
    for (const c of 'abcdefgh') hub.submit(quiet, w.edit(w.length, 0, c)); // 1-8
    hub.submit(quiet, w.edit(7, 1, '')); // 9: backspaces h, after the snapshot at 8
    hub.close();
    const again = open(root); // replays 9 from the log
    again.join(quiet, again.seq);
    for (const c of 'ijk') again.submit(quiet, w.edit(w.length, 0, c)); // to 12: lets go of 5-8 only
    assert.doesNotMatch(again.state(), /collected/, 'its delete is entry 9, still kept');
    for (const c of 'lmno') again.submit(quiet, w.edit(w.length, 0, c)); // to 16: lets go of 9-12
    assert.match(again.state(), /collected 8\+1@w$/);
    again.close();
  });

  test('a member still catching up holds collection back to what it has been sent', (t) => {
    const root = tempDir(t);
    const hub = open(root);
    const w = new Rga('w');
    hub.join(quiet, 0);
    for (const c of 'abc') hub.submit(quiet, w.edit(w.length, 0, c)); // 1-3
    // A member that never finishes reading its first batch (entries 1-3): it still needs 4 on.
    const stuck: Member = { replica: 's', send() {}, replace() {}, fail() {} };
    hub.join(stuck, 0);
    hub.submit(quiet, w.edit(2, 1, '')); // 4: backspaces c
    for (let i = 0; i < 12; i++) hub.submit(quiet, w.edit(w.length, 0, 'x')); // to 16
    assert.doesNotMatch(
      hub.state(),
      /collected/,
      'entry 4 is still to be sent to the stuck member',
    );
    hub.leave(stuck);
    for (let i = 0; i < 8; i++) hub.submit(quiet, w.edit(w.length, 0, 'y')); // to 24
    assert.match(hub.state(), /collected 3\+1@w$/);
    hub.close();
  });
});
