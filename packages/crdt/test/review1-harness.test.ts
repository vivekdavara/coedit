// Review 1 (at e688359): defects in the network simulator and its toys. Each test states what the docs promise; each
// failed until its fix.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import { convergence, type Replica, type Subject } from './harness/network.ts';
import { byIndex } from './harness/toys.ts';

// ---- A broken CRDT that passes only because every replica is handed the same op object ----

interface SharedInsert {
  readonly kind: 'insert';
  readonly counter: number;
  readonly replica: string;
  readonly char: string;
  /** Set by the replica that deletes it; the flaw is that remote delete operations are never applied. */
  deleted?: boolean;
}
type SharedOp = SharedInsert | { readonly kind: 'delete'; readonly key: string };

class IgnoresRemoteDeletes implements Replica<SharedOp> {
  readonly name: string;
  clock = 0;
  readonly elements: SharedInsert[] = [];

  constructor(name: string) {
    this.name = name;
  }

  visible(): SharedInsert[] {
    return this.elements
      .filter((e) => e.deleted !== true)
      .sort(
        (a, b) =>
          a.counter - b.counter || (a.replica < b.replica ? -1 : a.replica > b.replica ? 1 : 0),
      );
  }

  text(): string {
    return this.visible()
      .map((e) => e.char)
      .join('');
  }

  receive(op: SharedOp): void {
    if (op.kind === 'delete') return; // BUG: a delete made elsewhere is never applied here.
    this.clock = Math.max(this.clock, op.counter);
    if (this.elements.some((e) => e.counter === op.counter && e.replica === op.replica)) return;
    this.elements.push(op); // keeps the received object itself as its element
  }
}

const ignoresRemoteDeletes: Subject<SharedOp, IgnoresRemoteDeletes> = {
  name: 'ignores remote deletes',
  create: (name) => new IgnoresRemoteDeletes(name),
  edit(replica, index, deleteCount, text) {
    const ops: SharedOp[] = [];
    for (const e of replica.visible().slice(index, index + deleteCount)) {
      e.deleted = true; // local delete marks the element...
      ops.push({ kind: 'delete', key: `${e.counter}@${e.replica}` }); // ...and sends a delete nobody applies
    }
    for (const char of text) {
      const op: SharedInsert = {
        kind: 'insert',
        counter: ++replica.clock,
        replica: replica.name,
        char,
      };
      replica.receive(op);
      ops.push(op);
    }
    return ops;
  },
};

describe('review 1: the network simulator', () => {
  test('catches a CRDT that never applies remote deletes (messages must not be shared objects)', () => {
    // Over a real network every replica decodes its own copy, so a delete made at r0 never reaches r1's
    // element. In the simulator all replicas hold the same object, so the deleted flag "travels" for free.
    // Sanity: give each delivery its own copy, as a real network does, and the same toy is caught at once.
    const copying: Subject<SharedOp, IgnoresRemoteDeletes> = {
      ...ignoresRemoteDeletes,
      create(name) {
        const replica = ignoresRemoteDeletes.create(name);
        const receive = replica.receive.bind(replica);
        replica.receive = (op) => {
          receive(structuredClone(op));
        };
        return replica;
      },
    };
    assert.ok(fc.check(convergence(copying, {}), { numRuns: 2_000, seed: 1 }).failed);

    const details = fc.check(convergence(ignoresRemoteDeletes, {}), { numRuns: 2_000, seed: 1 });
    assert.ok(
      details.failed,
      `a CRDT that ignores every remote delete passed ${details.numRuns} schedules`,
    );
  });
});

describe('review 1: copies per delivery', () => {
  test('catches it even when the sender applies its own inserts only from the echo', () => {
    // Then every replica, the sender included, holds what the network delivered: with one copy per message
    // (made at send) rather than per delivery, all of them would share it and the deleted flag would travel.
    const echoOnly: Subject<SharedOp, IgnoresRemoteDeletes> = {
      ...ignoresRemoteDeletes,
      edit(replica, index, deleteCount, text) {
        const ops = ignoresRemoteDeletes.edit(replica, index, deleteCount, text);
        // Undo the local application of the inserts: they come back through the echo.
        for (const op of ops) {
          if (op.kind === 'insert') replica.elements.splice(replica.elements.indexOf(op), 1);
        }
        return ops;
      },
    };
    const details = fc.check(convergence(echoOnly, { echo: true }), { numRuns: 2_000, seed: 1 });
    assert.ok(details.failed, `passed ${details.numRuns} schedules`);
  });
});

describe('review 1: the toys', () => {
  test('byIndex is wrong only under concurrency (toys.ts: "concurrency is its only flaw")', () => {
    // With concurrency off, an edit's delete and insert can still be delivered to another replica in the
    // other order, and an insert-then-delete at one index deletes the inserted text.
    const details = fc.check(
      convergence(byIndex, { reorder: true, duplicates: false, echo: false, concurrency: false }),
      { numRuns: 2_000, seed: 1 },
    );
    assert.ok(
      !details.failed,
      `byIndex diverged without concurrent edits:\n${String(details.errorInstance)}`,
    );
  });
});
