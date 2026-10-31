/**
 * RGA, the Replicated Growable Array: the sequence CRDT under every document. DESIGN.md "The CRDT: RGA" is the
 * specification, and "Insert" has the argument for why every replica builds the same sequence.
 *
 * Each element is one code point with a Lamport id. An insert names its origin, the element it was typed after,
 * and a replica places it by one rule: start just after the origin, move right past every element whose id is
 * larger, stop at the first smaller one. A delete leaves tombstones. Operations may arrive in any order and any
 * number of times: one whose dependencies are missing waits, and a duplicate changes nothing.
 *
 * The elements live in blocks in document order, each block counting its visible elements, so finding a position
 * skips whole blocks: about n / B + B steps for B elements a block, not n. Day 4 measured the single array this
 * replaced at 1,462 local edits a second at 369,000 elements (README "Results (day 4)").
 */
import { IdMap, IdRanges, compareIds, formatId, sameId } from './ids.ts';
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

/**
 * The most live entries a V8 Map can be trusted with. A Map's table holds at most 2^24 entries, deleted ones
 * included until it rehashes, and when the table is full it grows (which fails at that size) unless at least half
 * of it is deleted entries. So a Map that has lost entries can refuse a `set` with as few as 2^23 + 1 live ones
 * (review 3 of day 2; measured: holding 2^23 + 2 entries while deleting one and adding one throws, 2^23 holds
 * through 20 million such turns). Kept at most 2^23 - 1 live entries, a full table is always at least half
 * deleted entries, so it compacts instead of growing.
 */
export const MAX_CAPACITY = 2 ** 23 - 1;

export interface RgaOptions {
  /** Where the Lamport clock starts (default 0). Tests start it near 2^31 and 2^53 to try large counters. */
  readonly clock?: number;
  /**
   * The most elements, the most ids deleted ahead, and the most waiting deletes this replica holds, each counted
   * on its own (default and maximum MAX_CAPACITY, 2^23 - 1). An operation that would hold more is refused with
   * RangeError before anything changes, instead of a Map refusing it halfway. Tests set it small.
   */
  readonly capacity?: number;
  /**
   * Elements per block (default 512): a block that grows past twice this is split into blocks of it. Only a speed
   * setting; tests set it small so blocks split all the time.
   */
  readonly blockSize?: number;
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

/**
 * An operation naming an element this replica has collected (Rga.collect): an insert whose ids or origin are among
 * them. Collected elements were deleted, and only a replica that hadn't seen the delete can still name them; the
 * server answers such an operation by resyncing its sender (DESIGN.md "Tombstones"). Nothing changes.
 */
export class CollectedError extends Error {
  constructor(problem: string) {
    super(problem);
    this.name = 'CollectedError';
  }
}

/** One insert operation's elements, placed together. */
interface Run {
  /** The operation, as checked and copied by validateOp: nothing outside holds it. */
  readonly op: InsertOp;
  /** Its elements in order; collection takes them from the end. */
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
  /** The block holding it; null while it waits for its origin. */
  block: Block | null;
  /** The largest stamp of the deletes naming it (apply's `stamp`; 0: none given). Collection goes by it. */
  deletedAt: number;
  /** Placed runs whose origin it is. */
  childRuns: number;
  /** Taken out by collect(). */
  gone: boolean;
}

/** A stretch of the sequence: its elements in order, and how many of them are visible. */
interface Block {
  readonly elements: Element[];
  visible: number;
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
  /** The placed elements, tombstones included, in document order, in blocks. */
  #blocks: Block[] = [];
  /** Placed elements, tombstones included. */
  #placed = 0;
  readonly #blockSize: number;
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
  /** Ids collected (Rga.collect): deleted elements taken out for good. */
  readonly #collected = new IdRanges();

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
      throw new RangeError(`capacity ${capacity} isn't an integer from 1 to 2^23 - 1`);
    }
    const blockSize = options.blockSize ?? 512;
    if (!Number.isSafeInteger(blockSize) || blockSize < 1) {
      throw new RangeError(`block size ${blockSize} isn't a positive integer`);
    }
    this.replica = replica;
    this.#clock = clock;
    this.#capacity = capacity;
    this.#blockSize = blockSize;
  }

  /** The visible text. */
  text(): string {
    let text = '';
    for (const block of this.#blocks)
      for (const e of block.elements) if (!e.deleted) text += e.char;
    return text;
  }

  /** Visible code points. */
  get length(): number {
    return this.#length;
  }

  /**
   * The largest counter among this replica's own ids, the inserts it has received (waiting ones too), and the ids
   * under its own id that deletes have named; its next insert takes the one after. A delete naming other replicas'
   * ids doesn't move it.
   */
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

  /** The most elements, ids deleted ahead and waiting deletes this replica holds, each (RgaOptions.capacity). */
  get capacity(): number {
    return this.#capacity;
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
    collected: number;
  } {
    return {
      elements: this.#known.size,
      tombstones: this.#placed - this.#length,
      waitingRuns: this.#waitingRuns,
      deletedAhead: this.#deletedAhead.size,
      waitingDeletes: this.#waitingDeletes.size,
      collected: this.#collected.size,
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

    // The origin is the visible element before `index`; the targets are the `deleteCount` from it. The walk starts
    // at the block holding the first of them, skips blocks with nothing visible, and stops at the last one needed:
    // walking on to the next visible element crossed every tombstone after the caret, block by block, so typing
    // after a large deletion cost what the single array did (review 2 of day 4).
    let origin: Element | null = null;
    const targets: Element[] = [];
    const end = index + deleteCount;
    if (end > 0) {
      const from = this.#findVisible(Math.max(index - 1, 0));
      let visible = from.before;
      walk: for (let b = from.b; b < this.#blocks.length; b++) {
        const block = this.#blocks[b] as Block;
        if (block.visible === 0) continue;
        for (const e of block.elements) {
          if (e.deleted) continue;
          if (visible === index - 1) origin = e;
          else if (visible >= index) targets.push(e);
          if (++visible >= end) break walk;
        }
      }
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
   * known id with other content, CollectedError for an insert naming a collected element, and RangeError for one
   * that would pass the capacity; it changes nothing then. `stamp` (the server passes the log entry's sequence
   * number) is recorded on every element a delete names, for collect(); ids a delete names that were collected are
   * deleted already, and skipped.
   */
  apply(op: Op, stamp = 0): Change[] {
    return this.#apply(validateOp(op), stamp);
  }

  #apply(op: Op, stamp = 0): Change[] {
    return op.type === 'insert' ? this.#insert(op) : this.#delete(op, stamp);
  }

  /** Whether this replica holds the element `id`, placed or waiting for its origin. */
  has(id: Id): boolean {
    return this.#known.has(id);
  }

  /**
   * Whether `op`'s dependencies are all placed here, so that applying it leaves nothing waiting: an insert's origin
   * (or HEAD), every id a delete names. The server accepts only such operations, so it never holds a waiting one
   * (DESIGN.md "The sync protocol"). A delete's spans are checked run by run, not id by id: a span over a few long
   * runs costs a few lookups, however many ids it names. (Applying it still visits every id; the server refuses
   * overlapping spans and a message whose deletes name more ids than it holds, so that is bounded by the document's
   * size per message.) Throws ProtocolError for an operation that isn't valid.
   */
  ready(op: Op): boolean {
    const checked = validateOp(op);
    if (checked.type === 'insert') {
      return checked.origin === null || this.#known.get(checked.origin)?.run.placed === true;
    }
    for (const span of checked.spans) {
      // validateOp checked that the span's last counter is a safe integer.
      const last = span.counter + span.length - 1;
      let counter = span.counter;
      while (counter <= last) {
        const e = this.#known.get({ replica: span.replica, counter });
        if (e?.run.placed !== true) return false;
        // Every id from here to the end of e's run is placed with it.
        counter = e.run.op.id.counter + e.run.elements.length;
      }
    }
    return true;
  }

  #insert(op: InsertOp): Change[] {
    const chars = Array.from(op.text);
    if (this.#collected.overlaps(op.id.replica, op.id.counter, op.id.counter + chars.length - 1)) {
      throw new CollectedError(`${formatId(op.id)}: names ids this replica has collected`);
    }
    if (op.origin !== null && this.#collected.has(op.origin)) {
      throw new CollectedError(
        `${formatId(op.id)}: its origin ${formatId(op.origin)} was collected`,
      );
    }
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
        block: null,
        deletedAt: 0,
        childRuns: 0,
        gone: false,
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
    const blocks = this.#blocks;
    const first = run.op.id;
    const origin = run.op.origin === null ? null : (this.#known.get(run.op.origin) as Element);
    // (b, i): where the scan is, as a block and an index in it; visible: the visible elements before it.
    let b = 0;
    let i = 0;
    let visible = 0;
    if (origin !== null) {
      const at = this.#locate(origin);
      b = at.b;
      i = at.i + 1;
      visible = at.before + (origin.deleted ? 0 : 1);
    }
    for (;;) {
      const block = blocks[b];
      if (block === undefined) break;
      const e = block.elements[i];
      if (e === undefined) {
        if (b + 1 === blocks.length) break; // the end of the sequence: insert at the end of the last block
        b++;
        i = 0;
        continue;
      }
      if (compareIds(e.id, first) < 0) break;
      if (!e.deleted) visible++;
      i++;
    }
    let block = blocks[b];
    if (block === undefined) {
      block = { elements: [], visible: 0 };
      blocks.push(block);
    }
    // eslint-disable-next-line no-restricted-syntax -- bounded: a run has at most MAX_INSERT_LENGTH (10,000) elements
    block.elements.splice(i, 0, ...run.elements);
    run.placed = true;
    this.#placed += run.elements.length;
    if (origin !== null) origin.childRuns++;
    // Elements deleted ahead of their insert are placed as tombstones, so only the rest show.
    let text = '';
    let shown = 0;
    for (const e of run.elements) {
      e.block = block;
      if (e.deleted) continue;
      text += e.char;
      shown++;
    }
    block.visible += shown;
    this.#length += shown;
    if (block.elements.length > 2 * this.#blockSize) this.#split(b);
    return shown === 0 ? null : { type: 'insert', index: visible, text };
  }

  /** Replaces block `b` by blocks of the block size. */
  #split(b: number): void {
    const old = this.#blocks[b] as Block;
    const parts: Block[] = [];
    for (let at = 0; at < old.elements.length; at += this.#blockSize) {
      const part: Block = { elements: old.elements.slice(at, at + this.#blockSize), visible: 0 };
      for (const e of part.elements) {
        e.block = part;
        if (!e.deleted) part.visible++;
      }
      parts.push(part);
    }
    this.#blocks = this.#blocks.slice(0, b).concat(parts, this.#blocks.slice(b + 1));
  }

  /** A placed element's block (its index), its index in the block, and the visible elements before it. */
  #locate(e: Element): { b: number; i: number; before: number } {
    const block = e.block as Block;
    const b = this.#blocks.indexOf(block);
    let before = 0;
    for (let k = 0; k < b; k++) before += (this.#blocks[k] as Block).visible;
    const i = block.elements.indexOf(e);
    for (let k = 0; k < i; k++) if (!(block.elements[k] as Element).deleted) before++;
    return { b, i, before };
  }

  /** The block holding visible element `index` (from 0), and the visible elements before that block. */
  #findVisible(index: number): { b: number; before: number } {
    let before = 0;
    let b = 0;
    while (b < this.#blocks.length - 1 && before + (this.#blocks[b] as Block).visible <= index) {
      before += (this.#blocks[b] as Block).visible;
      b++;
    }
    return { b, before };
  }

  #delete(op: DeleteOp, stamp: number): Change[] {
    // The same delete still waiting has nothing more to do: whatever it names that has arrived since was deleted
    // on arrival. Without this check a resend (a client resends its outbox on every reconnect) would add a second
    // wait for the same ids, which would end with the first; nothing visible would change, except that at the
    // capacity for waiting deletes the resend would be refused (review 3). (validateOp wrote the spans with their
    // keys in canonical order.)
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
        if (e === undefined && this.#collected.has(id)) continue; // deleted, and collected since
        if (e === undefined) {
          // Every delete naming a missing id waits for it, not only the first: otherwise which of two deletes
          // waits would depend on which arrived first.
          wait ??= { key, remaining: 0 };
          const waits = this.#deletedAhead.get(id);
          if (waits === undefined) this.#deletedAhead.set(id, [wait]);
          else waits.push(wait);
          wait.remaining++;
        } else {
          // The last delete naming it counts: one logged later than the first must not find it collected.
          e.deletedAt = Math.max(e.deletedAt, stamp);
          if (!e.deleted) {
            // An element still waiting for its origin is placed as a tombstone when it's placed.
            if (e.run.placed) targets.add(e);
            else e.deleted = true;
          }
        }
      }
    }
    if (wait !== null) this.#waitingDeletes.set(key, wait);
    if (targets.size === 0) return [];

    // One pass over the old sequence: each target's visible index, grouped into runs of consecutive indices, each
    // group's index shifted left by the groups before it (so the changes apply one after another). Blocks holding
    // no target are skipped by their visible count.
    const touched = new Set<Block>();
    for (const e of targets) touched.add(e.block as Block);
    const changes: Change[] = [];
    let visible = 0;
    let removed = 0;
    let start = 0;
    let count = 0;
    let found = 0;
    walk: for (const block of this.#blocks) {
      if (!touched.has(block)) {
        visible += block.visible;
        continue;
      }
      for (const e of block.elements) {
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
          if (++found === targets.size) break walk;
        }
        visible++;
      }
    }
    changes.push({ type: 'delete', index: start - removed, count });
    for (const e of targets) {
      e.deleted = true;
      (e.block as Block).visible--;
    }
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
   * even if none of its ids were here. An id named by several of one delete's spans counts once per span, so a
   * delete of overlapping spans can be refused early (by up to 1,000 times what it would record); only a peer
   * sending overlapping spans can cause that, and replicas holding the same state still decide the same.
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
    const { b, before } = this.#findVisible(index - 1);
    let visible = before;
    for (const e of (this.#blocks[b] as Block).elements) {
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
    const { before } = this.#locate(target);
    return before + (target.deleted ? 0 : 1);
  }

  /**
   * Operations that rebuild this replica's state (DESIGN.md "Persistence (day 4)"): every run's insert as it arrived,
   * in id order (counter, then replica), then deletes of the tombstones in sequence order. An insert's counter is
   * larger than its origin's, so each origin comes first, and applying the inserts in any order whose origins come
   * first gives the same sequence (that's the CRDT's convergence). Applied to a new replica they give this replica's
   * `state()`; applied to one holding some of the operations this replica has applied, they bring it to everything
   * this replica has. Id order also makes them cheap to apply: no larger id is placed yet, so each insert's scan stops
   * just after its origin. (The first version wrote them in sequence order, which is valid too, but a tombstone typed
   * early sits after everything typed after it, and placing it scanned past all of that: loading a snapshot of
   * 100,000 entries took 2,350 ms against 467 ms for the log.) The inserts are the original runs, not the stretches
   * the sequence now shows, since a run's middle sent as a run of its own would be a conflict. Throws for a replica
   * holding waiting operations, which have no place to be written at (the server never holds any).
   */
  snapshot(): Op[] {
    if (this.pending > 0) throw new Error(`${this.pending} operations are waiting: no snapshot`);
    const runs = new Set<Run>();
    const tombstones: Element[] = [];
    for (const block of this.#blocks) {
      for (const e of block.elements) {
        runs.add(e.run);
        if (e.deleted) tombstones.push(e);
      }
    }
    // A run whose end was collected is written as what's left of it.
    const ops: Op[] = [...runs]
      .sort((a, b) => compareIds(a.op.id, b.op.id))
      .map((run) =>
        validateOp(
          run.elements.length === Array.from(run.op.text).length
            ? run.op
            : { ...run.op, text: run.elements.map((e) => e.char).join('') },
        ),
      );
    const spans = spansOf(tombstones);
    for (let i = 0; i < spans.length; i += MAX_SPANS) {
      ops.push({ type: 'delete', spans: spans.slice(i, i + MAX_SPANS) });
    }
    return ops;
  }

  /**
   * Takes out every tombstone that is a leaf and was last deleted by a delete stamped from 1 to `upTo`, and then
   * every one that becomes a leaf that way (DESIGN.md "Tombstones"). A leaf is the last element of its run that no
   * run names as its origin (an element's run successor names it implicitly). RGA places an insert just after its
   * origin, past every larger id; where a leaf tombstone was the first smaller id, the element after it is smaller
   * still, so removing it changes where nothing goes, as long as no operation still to arrive names it: that is the
   * caller's to know (the server collects only tombstones deleted before the log it keeps, and resyncs a client that
   * names one). The ids are kept as collected (collectedSpans). Returns how many elements went.
   */
  collect(upTo: number): number {
    const eligible = (e: Element) =>
      e.deleted &&
      !e.gone &&
      e.deletedAt > 0 &&
      e.deletedAt <= upTo &&
      e.childRuns === 0 &&
      e.run.elements.at(-1) === e &&
      !this.#waiting.has(e.id);
    const stack: Element[] = [];
    for (const block of this.#blocks)
      for (const e of block.elements) if (eligible(e)) stack.push(e);
    const removed: Id[] = [];
    const touched = new Set<Block>();
    while (stack.length > 0) {
      const e = stack.pop() as Element;
      if (!eligible(e)) continue;
      e.gone = true;
      e.run.elements.pop();
      this.#known.delete(e.id);
      touched.add(e.block as Block);
      removed.push(e.id);
      const before = e.run.elements.at(-1);
      if (before !== undefined) {
        if (eligible(before)) stack.push(before);
      } else if (e.run.op.origin !== null) {
        // The whole run is gone: its origin has one child run fewer.
        const origin = this.#known.get(e.run.op.origin);
        if (origin !== undefined) {
          origin.childRuns--;
          if (eligible(origin)) stack.push(origin);
        }
      }
    }
    if (removed.length === 0) return 0;
    for (const block of touched) {
      let kept = 0;
      for (const e of block.elements) if (!e.gone) block.elements[kept++] = e;
      block.elements.length = kept;
    }
    this.#blocks = this.#blocks.filter((block) => block.elements.length > 0);
    this.#placed -= removed.length;
    this.#collected.addAll(removed);
    return removed.length;
  }

  /** The ids collected, as spans (each at most MAX_SPAN_LENGTH), by replica then counter: for snapshots. */
  collectedSpans(): Span[] {
    return this.#collected.spans(MAX_SPAN_LENGTH);
  }

  /**
   * Records ids as collected (a replica rebuilt from a snapshot: its collected spans). Throws RangeError if this
   * replica holds any of them. This replica's own ids move its clock past them, so it never makes them again.
   */
  markCollected(spans: readonly Span[]): void {
    for (const span of spans) {
      for (let i = 0; i < span.length; i++) {
        if (this.#known.has({ replica: span.replica, counter: span.counter + i })) {
          throw new RangeError(`${span.counter + i}@${span.replica} is held here, not collected`);
        }
      }
    }
    for (const span of spans) {
      this.#collected.addSpan(span.replica, span.counter, span.length);
      if (span.replica === this.replica) {
        this.#clock = Math.max(this.#clock, span.counter + span.length - 1);
      }
    }
  }

  /** Whether `id` is a placed element that's deleted (a tombstone here). */
  isTombstone(id: Id): boolean {
    const e = this.#known.get(id);
    return e !== undefined && e.run.placed && e.deleted;
  }

  /** Whether `id` was collected here. */
  isCollected(id: Id): boolean {
    return this.#collected.has(id);
  }

  /** Every placed element's id in sequence order, tombstones included (for a client re-anchoring its edits). */
  sequence(): Id[] {
    const ids: Id[] = [];
    for (const block of this.#blocks) {
      for (const e of block.elements) ids.push({ replica: e.id.replica, counter: e.id.counter });
    }
    return ids;
  }

  /** Whether `op` names a collected id: an insert's own ids or origin, any id a delete names. */
  namesCollected(op: Op): boolean {
    if (op.type === 'insert') {
      const last = op.id.counter + Array.from(op.text).length - 1;
      return (
        this.#collected.overlaps(op.id.replica, op.id.counter, last) ||
        (op.origin !== null && this.#collected.has(op.origin))
      );
    }
    return op.spans.some((s) =>
      this.#collected.overlaps(s.replica, s.counter, s.counter + s.length - 1),
    );
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
    const parts = [
      this.#blocks.flatMap((block) => block.elements.map(describe)).join(' '),
      `waiting ${runs.join(', ')}`,
      `deleted ahead ${this.#deletedAhead.ids().map(formatId).join(' ')}`,
    ];
    if (this.#collected.size > 0) {
      const spans = this.#collected.spans(Number.MAX_SAFE_INTEGER);
      parts.push(
        `collected ${spans.map((x) => `${x.counter}+${x.length}@${x.replica}`).join(' ')}`,
      );
    }
    return parts.join(' | ');
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
