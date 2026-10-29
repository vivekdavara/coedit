/**
 * RGA, the Replicated Growable Array: the sequence CRDT under every document. DESIGN.md "The CRDT: RGA" is the
 * specification, and "Insert" has the argument for why every replica builds the same sequence.
 *
 * Each element is one code point with a Lamport id. An insert names its origin, the element it was typed after,
 * and a replica places it by one rule: start just after the origin, move right past every element whose id is
 * larger, stop at the first smaller one. A delete leaves tombstones. Operations may arrive in any order and any
 * number of times: one whose dependencies are missing waits, and a duplicate changes nothing.
 *
 * The elements live in one array in document order, and positions are found by scanning it: O(n) per operation,
 * simple to check. Day 4 measures whether that's fast enough.
 */
import { IdMap, compareIds, formatId, sameId } from './ids.ts';
import {
  MAX_INSERT_LENGTH,
  MAX_SPAN_LENGTH,
  MAX_SPANS,
  isReplicaName,
  validateOp,
  type DeleteOp,
  type Id,
  type InsertOp,
  type Op,
  type Span,
} from './protocol.ts';

/**
 * A visible change an operation made, in code points. Applying an operation's changes in order to the text before
 * it gives the text after it.
 */
export type Change =
  | { readonly type: 'insert'; readonly index: number; readonly text: string }
  | { readonly type: 'delete'; readonly index: number; readonly count: number };

/** The most entries a V8 Map holds: past it, `set` throws (review 2 of day 2). */
export const MAX_CAPACITY = 2 ** 24 - 1;

export interface RgaOptions {
  /** Where the Lamport clock starts (default 0). Tests start it near 2^31 and 2^53 to try large counters. */
  readonly clock?: number;
  /**
   * The most elements, the most ids deleted ahead, and the most waiting deletes this replica holds, each counted
   * on its own (default and maximum MAX_CAPACITY, 2^24 - 1). An operation that would hold more is refused with
   * RangeError before anything changes, instead of a Map refusing it halfway. Tests set it small.
   */
  readonly capacity?: number;
}

/**
 * An insert that reuses an id this replica holds, with other content: another character, another origin, or a run
 * that's partly known (DESIGN.md "Order of delivery, duplicates, and conflicts"). Accepting it would split the
 * replicas apart for good, so it's refused and nothing changes. Only a buggy or tampered replica can send one.
 */
export class ConflictError extends Error {
  /** The first id of the operation that was already known. */
  readonly id: Id;

  constructor(id: Id, problem: string) {
    super(`${formatId(id)}: ${problem}`);
    this.name = 'ConflictError';
    this.id = id;
  }
}

/** One insert operation's elements, placed together. */
interface Run {
  /** The operation, as checked and copied by validateOp: nothing outside holds it. */
  readonly op: InsertOp;
  readonly elements: Element[];
  /** In the sequence; false while it waits for its origin. */
  placed: boolean;
}

interface Element {
  readonly id: Id;
  /** One code point. */
  readonly char: string;
  readonly run: Run;
  deleted: boolean;
}

/** A delete that named ids before their insert arrived: it waits until all `remaining` of them have arrived. */
interface DeleteWait {
  /** The delete's spans, written canonically: the same delete arriving again is the same wait. */
  readonly key: string;
  remaining: number;
}

export class Rga {
  readonly replica: string;
  #clock: number;
  /** The placed elements, tombstones included, in document order. */
  readonly #elements: Element[] = [];
  /** Every element this replica holds, placed or waiting. */
  readonly #known = new IdMap<Element>();
  /** Runs waiting for their origin, by the origin's id. */
  readonly #waiting = new IdMap<Run[]>();
  #waitingRuns = 0;
  /** Ids deleted before they arrived, each with every delete waiting for it. */
  readonly #deletedAhead = new IdMap<DeleteWait[]>();
  /** Deletes still waiting for an id, by key. */
  readonly #waitingDeletes = new Map<string, DeleteWait>();
  /** Visible elements. */
  #length = 0;
  readonly #capacity: number;

  constructor(replica: string, options: RgaOptions = {}) {
    if (!isReplicaName(replica)) {
      throw new RangeError(
        `replica ${JSON.stringify(replica)} isn't 1 to 32 characters of A-Z a-z 0-9 _ -`,
      );
    }
    const clock = options.clock ?? 0;
    if (!Number.isSafeInteger(clock) || clock < 0) {
      throw new RangeError(`clock ${clock} isn't an integer from 0 to 2^53 - 1`);
    }
    const capacity = options.capacity ?? MAX_CAPACITY;
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
      throw new RangeError(`capacity ${capacity} isn't an integer from 1 to 2^24 - 1`);
    }
    this.replica = replica;
    this.#clock = clock;
    this.#capacity = capacity;
  }

  /** The visible text. */
  text(): string {
    let text = '';
    for (const e of this.#elements) if (!e.deleted) text += e.char;
    return text;
  }

  /** Visible code points. */
  get length(): number {
    return this.#length;
  }

  /** The largest counter this replica has made or seen; its next insert takes the one after. */
  get clock(): number {
    return this.#clock;
  }

  /**
   * Operations waiting for a dependency: inserts whose origin hasn't been placed, deletes naming ids no insert
   * here has carried. Each distinct operation counts once, however often it arrived, so like the state this
   * depends only on which operations arrived, not on their order.
   */
  get pending(): number {
    return this.#waitingRuns + this.#waitingDeletes.size;
  }

  /**
   * What this replica holds, for measurements: every element (placed, tombstones and waiting ones included), the
   * placed tombstones, the runs and deletes waiting, and the ids deleted ahead. The capacity bounds `elements`,
   * `deletedAhead` and `waitingDeletes`.
   */
  sizes(): {
    elements: number;
    tombstones: number;
    waitingRuns: number;
    deletedAhead: number;
    waitingDeletes: number;
  } {
    return {
      elements: this.#known.size,
      tombstones: this.#elements.length - this.#length,
      waitingRuns: this.#waitingRuns,
      deletedAhead: this.#deletedAhead.size,
      waitingDeletes: this.#waitingDeletes.size,
    };
  }

  /**
   * A local edit, in code points: deletes `deleteCount` visible elements from `index`, then inserts `text` there.
   * Applied at once; returns the operations to send, deletes first. A text longer than one insert may carry
   * becomes several inserts, each after the last; a delete of more spans than one may carry, several deletes.
   */
  edit(index: number, deleteCount: number, text: string): Op[] {
    const length = this.#length;
    if (!Number.isSafeInteger(index) || index < 0 || index > length) {
      throw new RangeError(`index ${index} is outside 0 to ${length}`);
    }
    if (!Number.isSafeInteger(deleteCount) || deleteCount < 0 || deleteCount > length - index) {
      throw new RangeError(`can't delete ${deleteCount} from ${index} of ${length}`);
    }
    if (!text.isWellFormed()) throw new RangeError('the text has a lone surrogate');
    const chars = Array.from(text);
    if (chars.length > Number.MAX_SAFE_INTEGER - this.#clock) {
      throw new RangeError(`the clock is at ${this.#clock}: no counters left for ${chars.length}`);
    }
    // Checked here too, not only in #insert: the edit's deletes are applied before its inserts.
    this.#makeRoom(chars.length);

    // The origin is the visible element before `index`; the targets are the `deleteCount` from it.
    let origin: Element | null = null;
    const targets: Element[] = [];
    let visible = 0;
    for (const e of this.#elements) {
      if (e.deleted) continue;
      if (visible >= index + deleteCount) break;
      if (visible === index - 1) origin = e;
      else if (visible >= index) targets.push(e);
      visible++;
    }

    const ops: Op[] = [];
    const spans = spansOf(targets);
    for (let i = 0; i < spans.length; i += MAX_SPANS) {
      ops.push({ type: 'delete', spans: spans.slice(i, i + MAX_SPANS) });
    }
    // A copy: the element's own id object would let the caller rename the element through the op (review 1).
    let after: Id | null =
      origin === null ? null : { replica: origin.id.replica, counter: origin.id.counter };
    for (let i = 0; i < chars.length; i += MAX_INSERT_LENGTH) {
      const run = chars.slice(i, i + MAX_INSERT_LENGTH);
      const id = { replica: this.replica, counter: this.#clock + 1 + i };
      ops.push({ type: 'insert', id, origin: after, text: run.join('') });
      after = { replica: this.replica, counter: id.counter + run.length - 1 };
    }
    // Applied as checked copies, like a remote operation, so the caller can't change them afterwards. The ids are
    // fresh, larger than every id here, so each insert lands right after its origin.
    for (const op of ops) this.#apply(validateOp(op));
    return ops;
  }

  /**
   * Applies an operation from anyone, this replica's own echoes included. Returns the visible changes in order:
   * none for a duplicate or an operation still waiting; when an operation completes the dependencies of waiting
   * ones, theirs too. Throws ProtocolError for an operation that isn't valid, ConflictError for one that reuses a
   * known id with other content, and RangeError for one that would pass the capacity; it changes nothing then.
   */
  apply(op: Op): Change[] {
    return this.#apply(validateOp(op));
  }

  #apply(op: Op): Change[] {
    return op.type === 'insert' ? this.#insert(op) : this.#delete(op);
  }

  #insert(op: InsertOp): Change[] {
    const chars = Array.from(op.text);
    // A run is created whole by one replica, which never reuses a counter, so a run that arrives again is known
    // whole, as the same run: the same first id, origin and text. Anything else that touches a known id is a
    // conflict, so whether two inserts conflict doesn't depend on which arrives first. Waiting runs count: their
    // elements are known.
    const known = this.#known.get(op.id);
    if (known !== undefined) {
      const run = known.run;
      if (
        run.elements[0] === known &&
        sameId(run.op.origin, op.origin) &&
        run.op.text === op.text
      ) {
        return [];
      }
      throw new ConflictError(op.id, `already known, in ${describeRun(run)}`);
    }
    for (let i = 1; i < chars.length; i++) {
      const id = { replica: op.id.replica, counter: op.id.counter + i };
      const e = this.#known.get(id);
      if (e !== undefined) throw new ConflictError(id, `already known, in ${describeRun(e.run)}`);
    }
    this.#makeRoom(chars.length);
    this.#clock = Math.max(this.#clock, op.id.counter + chars.length - 1);
    const run: Run = { op, elements: [], placed: false };
    for (let i = 0; i < chars.length; i++) {
      const e: Element = {
        id: { replica: op.id.replica, counter: op.id.counter + i },
        char: chars[i] as string,
        run,
        deleted: false,
      };
      run.elements.push(e);
      this.#known.set(e.id, e);
      const waits = this.#deletedAhead.get(e.id);
      if (waits !== undefined) {
        this.#deletedAhead.delete(e.id);
        e.deleted = true;
        for (const wait of waits) if (--wait.remaining === 0) this.#waitingDeletes.delete(wait.key);
      }
    }
    if (op.origin !== null && this.#known.get(op.origin)?.run.placed !== true) {
      const waiting = this.#waiting.get(op.origin);
      if (waiting === undefined) this.#waiting.set(op.origin, [run]);
      else waiting.push(run);
      this.#waitingRuns++;
      return [];
    }
    // Place it, then every run that was waiting for one of its elements, and so on.
    const changes: Change[] = [];
    const queue = [run];
    for (let q = 0; q < queue.length; q++) {
      const next = queue[q] as Run;
      const change = this.#place(next);
      if (change !== null) changes.push(change);
      for (const e of next.elements) {
        const waiting = this.#waiting.get(e.id);
        if (waiting === undefined) continue;
        this.#waiting.delete(e.id);
        this.#waitingRuns -= waiting.length;
        // One at a time, not push(...waiting): any number of runs can wait on one element, and spreading a list
        // of about 110,000 overflowed the stack after this insert was placed and the runs were taken out of
        // #waiting, losing them (review 1).
        for (const w of waiting) queue.push(w);
      }
    }
    return changes;
  }

  /** RGA's rule: just after the origin, past every larger id. The origin is placed. */
  #place(run: Run): Change | null {
    const elements = this.#elements;
    const first = run.op.id;
    const origin = run.op.origin === null ? null : (this.#known.get(run.op.origin) as Element);
    let i = 0;
    let visible = 0;
    if (origin !== null) {
      for (;;) {
        const e = elements[i++] as Element;
        if (!e.deleted) visible++;
        if (e === origin) break;
      }
    }
    for (; i < elements.length; i++) {
      const e = elements[i] as Element;
      if (compareIds(e.id, first) < 0) break;
      if (!e.deleted) visible++;
    }
    // A spread is safe here: a run has at most MAX_INSERT_LENGTH (10,000) elements.
    elements.splice(i, 0, ...run.elements);
    run.placed = true;
    // Elements deleted ahead of their insert are placed as tombstones, so only the rest show.
    let text = '';
    let shown = 0;
    for (const e of run.elements) {
      if (e.deleted) continue;
      text += e.char;
      shown++;
    }
    this.#length += shown;
    return shown === 0 ? null : { type: 'insert', index: visible, text };
  }

  #delete(op: DeleteOp): Change[] {
    // The same delete still waiting has nothing more to do: whatever it names that has arrived since was deleted
    // on arrival. Without this check a resend (a client resends its outbox on every reconnect) would add a second
    // wait for the same ids, which would end with the first, so nothing visible changes; it's here so resends don't
    // pile up. (validateOp wrote the spans with their keys in canonical order.)
    const key = JSON.stringify(op.spans);
    if (this.#waitingDeletes.has(key)) return [];
    this.#checkDeleteRoom(op);
    const targets = new Set<Element>();
    let wait: DeleteWait | null = null;
    for (const span of op.spans) {
      // This replica's next ids must not be ones a delete has named ahead, or its next insert would arrive
      // deleted (only a buggy peer can name them). Other replicas' counters needn't move the clock: a delete
      // makes no element that could be an origin, and a delete naming 2^53 - 1 of anyone would otherwise stop this
      // replica's inserts for good (review 1).
      if (span.replica === this.replica) {
        this.#clock = Math.max(this.#clock, span.counter + span.length - 1);
      }
      for (let i = 0; i < span.length; i++) {
        const id = { replica: span.replica, counter: span.counter + i };
        const e = this.#known.get(id);
        if (e === undefined) {
          // Every delete naming a missing id waits for it, not only the first: otherwise which of two deletes
          // waits would depend on which arrived first.
          wait ??= { key, remaining: 0 };
          const waits = this.#deletedAhead.get(id);
          if (waits === undefined) this.#deletedAhead.set(id, [wait]);
          else waits.push(wait);
          wait.remaining++;
        } else if (!e.deleted) {
          // An element still waiting for its origin is placed as a tombstone when it's placed.
          if (e.run.placed) targets.add(e);
          else e.deleted = true;
        }
      }
    }
    if (wait !== null) this.#waitingDeletes.set(key, wait);
    if (targets.size === 0) return [];

    // One pass over the old sequence: each target's visible index, grouped into runs of consecutive indices, each
    // group's index shifted left by the groups before it (so the changes apply one after another).
    const changes: Change[] = [];
    let visible = 0;
    let removed = 0;
    let start = 0;
    let count = 0;
    let found = 0;
    for (const e of this.#elements) {
      if (e.deleted) continue;
      if (targets.has(e)) {
        if (count > 0 && start + count === visible) {
          count++;
        } else {
          if (count > 0) changes.push({ type: 'delete', index: start - removed, count });
          removed += count;
          start = visible;
          count = 1;
        }
        if (++found === targets.size) break;
      }
      visible++;
    }
    changes.push({ type: 'delete', index: start - removed, count });
    for (const e of targets) e.deleted = true;
    this.#length -= targets.size;
    return changes;
  }

  /** Refuses, before any change, an insert of `count` elements that would hold more than the capacity. */
  #makeRoom(count: number): void {
    if (this.#known.size + count > this.#capacity) {
      throw new RangeError(
        `${count} more elements would pass this replica's capacity of ${this.#capacity} (it holds ${this.#known.size})`,
      );
    }
  }

  /**
   * Refuses, before any change, a delete that would record more ids deleted ahead, or more waiting deletes, than
   * the capacity. Counting needs a pass over every id, so it's skipped when the delete couldn't reach the capacity
   * even if none of its ids were here. An id named twice by one delete counts twice: refusing a little early is
   * safe.
   */
  #checkDeleteRoom(op: DeleteOp): void {
    let named = 0;
    for (const span of op.spans) named += span.length;
    if (
      this.#deletedAhead.size + named <= this.#capacity &&
      this.#waitingDeletes.size < this.#capacity
    ) {
      return;
    }
    let absent = 0;
    let added = 0;
    for (const span of op.spans) {
      for (let i = 0; i < span.length; i++) {
        const id = { replica: span.replica, counter: span.counter + i };
        if (this.#known.has(id)) continue;
        absent++;
        if (!this.#deletedAhead.has(id)) added++;
      }
    }
    if (this.#deletedAhead.size + added > this.#capacity) {
      throw new RangeError(
        `${added} more ids deleted ahead would pass this replica's capacity of ${this.#capacity}`,
      );
    }
    if (absent > 0 && this.#waitingDeletes.size >= this.#capacity) {
      throw new RangeError(
        `another waiting delete would pass this replica's capacity of ${this.#capacity}`,
      );
    }
  }

  /**
   * For presence: the id of the visible element just before `index`, or null at 0 (the start). A cursor kept as
   * "just after this id" stays next to the same text while others edit before it.
   */
  idBefore(index: number): Id | null {
    if (!Number.isSafeInteger(index) || index < 0 || index > this.#length) {
      throw new RangeError(`index ${index} is outside 0 to ${this.#length}`);
    }
    if (index === 0) return null;
    let visible = 0;
    for (const e of this.#elements) {
      if (!e.deleted && ++visible === index)
        return { replica: e.id.replica, counter: e.id.counter };
    }
    throw new Error(`only ${visible} visible elements, but the length is ${this.#length}`);
  }

  /**
   * Where the position just after element `id` is now: the number of visible elements up to and including it. For
   * a tombstone that's the visible elements before it, so a cursor after deleted text moves to where it was.
   * Null (the start) is 0. Undefined for an element that isn't placed here: unknown, or waiting for its origin.
   */
  indexAfter(id: Id | null): number | undefined {
    if (id === null) return 0;
    const target = this.#known.get(id);
    if (target?.run.placed !== true) return undefined;
    let visible = 0;
    for (const e of this.#elements) {
      if (!e.deleted) visible++;
      if (e === target) return visible;
    }
    throw new Error(`${formatId(id)} is placed but not in the sequence`);
  }

  /**
   * The whole state, written canonically: every placed element in order (`counter@replica`, then `<origin` on
   * the first of a run, `~` for a tombstone, then the character), the runs waiting for their origin, and the ids
   * deleted ahead of their insert. Two replicas with the same state hold the same document and will place any
   * future operation the same way.
   */
  state(): string {
    const waiting: Run[] = [];
    for (const id of this.#waiting.ids())
      for (const run of this.#waiting.get(id) as Run[]) waiting.push(run);
    waiting.sort((a, b) => compareIds(a.op.id, b.op.id));
    const runs = waiting.map((run) => run.elements.map(describe).join(' '));
    return [
      this.#elements.map(describe).join(' '),
      `waiting ${runs.join(', ')}`,
      `deleted ahead ${this.#deletedAhead.ids().map(formatId).join(' ')}`,
    ].join(' | ');
  }
}

function describeRun(run: Run): string {
  return `the run ${formatId(run.op.id)} after ${formatId(run.op.origin)}, ${JSON.stringify(run.op.text)}`;
}

function describe(e: Element): string {
  const origin = e.run.elements[0] === e ? `<${formatId(e.run.op.origin)}` : '';
  return `${formatId(e.id)}${origin}${e.deleted ? '~' : ''}${JSON.stringify(e.char)}`;
}

/** Ids as spans: consecutive counters of one replica, in document order, each at most MAX_SPAN_LENGTH. */
function spansOf(elements: readonly Element[]): Span[] {
  const spans: { replica: string; counter: number; length: number }[] = [];
  let last: (typeof spans)[number] | undefined;
  for (const { id } of elements) {
    if (
      last !== undefined &&
      last.replica === id.replica &&
      last.counter + last.length === id.counter &&
      last.length < MAX_SPAN_LENGTH
    ) {
      last.length++;
    } else {
      last = { replica: id.replica, counter: id.counter, length: 1 };
      spans.push(last);
    }
  }
  return spans;
}
