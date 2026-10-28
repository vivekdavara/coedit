// Review 2 (at e96122f): review 1's broken toy shared its element objects through the op objects, and the simulator
// now copies those. The same flaw still passes when the sharing goes through the subject instead: a module-level
// cache of elements by id (an easy day-2 mistake in a class-based RGA, e.g. a static Map of nodes). Every replica
// then sees every delete at once, so one that never applies a remote delete converges on every schedule.
// The simulator could see it: a local edit must change only its own replica, a delivery only its target.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { convergence, replicaName, type Replica, type Subject } from './harness/network.ts';

interface Element {
  readonly counter: number;
  readonly replica: string;
  readonly char: string;
  deleted: boolean;
}
type Op =
  | {
      readonly kind: 'insert';
      readonly counter: number;
      readonly replica: string;
      readonly char: string;
    }
  | { readonly kind: 'delete'; readonly key: string };

const key = (counter: number, replica: string) => `${counter}@${replica}`;

class CachedReplica implements Replica<Op> {
  clock = 0;
  readonly held = new Set<string>();
  readonly name: string;
  readonly cache: Map<string, Element>;
  constructor(name: string, cache: Map<string, Element>) {
    this.name = name;
    this.cache = cache;
  }

  visible(): Element[] {
    return [...this.held]
      .map((k) => this.cache.get(k) as Element)
      .filter((e) => !e.deleted)
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

  state(): string {
    return [...this.held]
      .sort()
      .map((k) => `${k}${(this.cache.get(k) as Element).deleted ? '(deleted)' : ''}`)
      .join(' ');
  }

  receive(op: Op): void {
    if (op.kind === 'delete') return; // BUG: a delete made elsewhere is never applied here.
    this.clock = Math.max(this.clock, op.counter);
    const k = key(op.counter, op.replica);
    if (!this.cache.has(k)) this.cache.set(k, { ...op, deleted: false });
    this.held.add(k);
  }
}

/** One cache per run of the property, shared by that run's replicas (as a static field would be). */
function cachedSubject(): Subject<Op, CachedReplica> {
  let cache = new Map<string, Element>();
  return {
    name: 'ignores remote deletes, elements cached by id',
    create(name) {
      if (name === replicaName(0)) cache = new Map(); // a fresh cache for each schedule (replica 0 comes first)
      return new CachedReplica(name, cache);
    },
    edit(replica, index, deleteCount, text) {
      const ops: Op[] = [];
      for (const e of replica.visible().slice(index, index + deleteCount)) {
        e.deleted = true; // marks the shared element: every replica sees it
        ops.push({ kind: 'delete', key: key(e.counter, e.replica) });
      }
      for (const char of text) {
        const op: Op = { kind: 'insert', counter: ++replica.clock, replica: replica.name, char };
        replica.receive(op);
        ops.push(op);
      }
      return ops;
    },
  };
}

test('catches a CRDT that never applies remote deletes, sharing elements through a cache rather than the ops', () => {
  // Sanity: with a cache per replica the same toy is caught at once, so the flaw is real.
  const ownCache: Subject<Op, CachedReplica> = {
    ...cachedSubject(),
    create: (name) => new CachedReplica(name, new Map()),
  };
  assert.ok(fc.check(convergence(ownCache, {}), { numRuns: 2_000, seed: 1 }).failed);

  const details = fc.check(convergence(cachedSubject(), {}), { numRuns: 2_000, seed: 1 });
  assert.ok(
    details.failed,
    `a CRDT that ignores every remote delete passed ${details.numRuns} schedules`,
  );
});
