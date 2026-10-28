/**
 * Toy replicated texts for the network simulator's self-test (DESIGN.md "Testing convergence"). One is correct;
 * each of the others is wrong in exactly one way, and the self-test checks that the simulator catches each one
 * when, and only when, the network freedom that exposes its flaw is switched on.
 *
 * None of these is an editor: the "sorted" ones ignore where text was typed. They exist to test the tester.
 */
import type { Replica, Subject } from './network.ts';

// ---- Sorted: characters with unique ids, shown in id order ----

type SortedOp =
  | {
      readonly kind: 'insert';
      readonly counter: number;
      readonly replica: string;
      readonly char: string;
    }
  | { readonly kind: 'delete'; readonly key: string };

interface SortedFlaws {
  /** An insert that arrives again adds a second copy. */
  readonly notIdempotent?: boolean;
  /** A delete that arrives before its insert is dropped, so the character comes back when the insert arrives. */
  readonly assumesCausalDelivery?: boolean;
  /**
   * A local delete removes the character outright instead of leaving a tombstone. The text is still right
   * everywhere; the hidden state isn't (in RGA, a later insert after that character would land elsewhere).
   */
  readonly dropsLocalTombstones?: boolean;
}

interface SortedElement {
  readonly counter: number;
  readonly replica: string;
  readonly char: string;
}

const key = (counter: number, replica: string) => `${counter}@${replica}`;

class SortedReplica implements Replica<SortedOp> {
  readonly name: string;
  clock = 0;
  /** Every copy received; the correct subject keeps one per id. */
  readonly elements: SortedElement[] = [];
  readonly deleted = new Set<string>();
  readonly flaws: SortedFlaws;

  constructor(name: string, flaws: SortedFlaws) {
    this.name = name;
    this.flaws = flaws;
  }

  visible(): SortedElement[] {
    return this.elements
      .filter((e) => !this.deleted.has(key(e.counter, e.replica)))
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

  /** Every element held (with its tombstone flag, in id order), then every id deleted, whether held or not. */
  state(): string {
    const elements = [...this.elements]
      .sort(
        (a, b) =>
          a.counter - b.counter || (a.replica < b.replica ? -1 : a.replica > b.replica ? 1 : 0),
      )
      .map((e) => {
        const k = key(e.counter, e.replica);
        return `${k}=${JSON.stringify(e.char)}${this.deleted.has(k) ? '(deleted)' : ''}`;
      });
    return `${elements.join(' ')} | deleted ${[...this.deleted].sort().join(' ')}`;
  }

  has(k: string): boolean {
    return this.elements.some((e) => key(e.counter, e.replica) === k);
  }

  receive(op: SortedOp): void {
    if (op.kind === 'insert') {
      this.clock = Math.max(this.clock, op.counter);
      if (!this.flaws.notIdempotent && this.has(key(op.counter, op.replica))) return;
      this.elements.push({ counter: op.counter, replica: op.replica, char: op.char });
    } else {
      if (this.flaws.assumesCausalDelivery && !this.has(op.key)) return;
      this.deleted.add(op.key);
    }
  }
}

function sorted(name: string, flaws: SortedFlaws = {}): Subject<SortedOp, SortedReplica> {
  return {
    name,
    create: (replicaName) => new SortedReplica(replicaName, flaws),
    edit(replica, index, deleteCount, text) {
      const ops: SortedOp[] = replica
        .visible()
        .slice(index, index + deleteCount)
        .map((e) => ({ kind: 'delete', key: key(e.counter, e.replica) }));
      for (const char of text) {
        ops.push({ kind: 'insert', counter: replica.clock + 1, replica: replica.name, char });
        replica.clock++;
      }
      for (const op of ops) {
        if (op.kind === 'delete' && flaws.dropsLocalTombstones) {
          const at = replica.elements.findIndex((e) => key(e.counter, e.replica) === op.key);
          replica.elements.splice(at, 1);
        } else {
          replica.receive(op);
        }
      }
      return ops;
    },
  };
}

/** Correct: inserts and deletes commute, duplicates are no-ops, early deletes are kept. */
export const sortedText = sorted('sorted text');
export const notIdempotent = sorted('sorted text, not idempotent', { notIdempotent: true });
export const assumesCausalDelivery = sorted('sorted text, assumes causal delivery', {
  assumesCausalDelivery: true,
});
export const dropsLocalTombstones = sorted('sorted text, drops local tombstones', {
  dropsLocalTombstones: true,
});

// ---- By index: operations name positions, as a plain text editor's undo log would ----

type IndexOp =
  | {
      readonly kind: 'insert';
      readonly opId: string;
      readonly index: number;
      readonly text: string;
    }
  | {
      readonly kind: 'delete';
      readonly opId: string;
      readonly index: number;
      readonly count: number;
    };

class IndexReplica implements Replica<IndexOp> {
  readonly name: string;
  codePoints: string[] = [];
  readonly seen = new Set<string>();
  nextOp = 0;

  constructor(name: string) {
    this.name = name;
  }

  text(): string {
    return this.codePoints.join('');
  }

  receive(op: IndexOp): void {
    // Idempotent and tolerant of positions past the end, so concurrency is its only flaw.
    if (this.seen.has(op.opId)) return;
    this.seen.add(op.opId);
    const index = Math.min(op.index, this.codePoints.length);
    if (op.kind === 'insert') this.codePoints.splice(index, 0, ...Array.from(op.text));
    else this.codePoints.splice(index, op.count);
  }
}

/** Wrong: a position means different text once a concurrent edit has landed before it. */
export const byIndex: Subject<IndexOp, IndexReplica> = {
  name: 'text by index',
  create: (name) => new IndexReplica(name),
  edit(replica, index, deleteCount, text) {
    const ops: IndexOp[] = [];
    if (deleteCount > 0) {
      ops.push({
        kind: 'delete',
        opId: `${replica.name}.${replica.nextOp++}`,
        index,
        count: deleteCount,
      });
    }
    if (text !== '')
      ops.push({ kind: 'insert', opId: `${replica.name}.${replica.nextOp++}`, index, text });
    for (const op of ops) replica.receive(op);
    return ops;
  },
};
