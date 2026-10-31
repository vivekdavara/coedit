/**
 * A document hub: the server's replica of one document, its numbered log, and the clients joined to it
 * (DESIGN.md "The sync protocol"). Nothing here knows about sockets: a member is anything that can take a message
 * and be closed, so the tests drive a hub directly.
 *
 * The server orders. Every operation it accepts gets the next sequence number and goes to every member, its sender
 * included: the echo is the sender's acknowledgement. It accepts only operations whose dependencies it has placed
 * (Rga.ready), so its replica never holds a waiting operation and its log is in causal order; anything else it
 * refuses, and the server closes that connection.
 */
import {
  ConflictError,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_SPANS,
  PROTOCOL_VERSION,
  ProtocolError,
  Rga,
  batchEnd,
  batchOps,
  codePoints,
  encodeOp,
  encodeServerMessage,
  encodeServerOps,
  encodeServerSnapshot,
  formatId,
  type Cursor,
  type ErrorCode,
  type Op,
  type Span,
} from '@coedit/crdt';
import { DocumentStore, StoreError, type StoreOptions } from './store.ts';

/** A client joined to a hub. */
export interface Member {
  readonly replica: string;
  /**
   * Sends one server message, already encoded. With `sent`, calls it once the message has been written out (handed
   * to the operating system), and not at all if the connection is going: the catch-up is paced by it.
   */
  send(text: string, sent?: () => void): void;
  /** Ends the connection without an error message (a newer connection of the same replica replaced it). */
  replace(): void;
  /** Sends the error and ends the connection (the hub can't go on: its storage failed). */
  fail(refusal: Refusal): void;
}

/** Why the hub refused a join or an operation: the error message to send before closing the connection. */
export interface Refusal {
  readonly code: ErrorCode;
  readonly message: string;
}

export interface HubOptions {
  /** The server replica's capacity (Rga's); tests set it small. */
  readonly capacity?: number;
  /**
   * Where the document is kept: the directory holding one directory per document (DocumentStore), and whether to
   * fsync. Without it the document lives in memory only and is lost when the server stops.
   */
  readonly store?: StoreOptions & { readonly root: string };
  /** With a store: write a snapshot once this many entries have been logged since the last one (default 10,000). */
  readonly snapshotEvery?: number;
  /** With a store: collect leaf tombstones at each snapshot (DESIGN.md "Tombstones"; default on). */
  readonly collect?: boolean;
}

interface MemberState {
  /** Its cursor; null until it sends one, or after it hides it. */
  cursor: Cursor | null;
  /** The next log entry its catch-up sends; null once caught up and receiving live relays. */
  next: number | null;
  /**
   * A snapshot it gets before the log (it joined with a `have` older than the log kept): the operations, how many
   * have been sent, and the entry it's the state after. Null once sent, or if it needs none.
   */
  snapshot: {
    readonly seq: number;
    readonly ops: readonly string[];
    at: number;
    /** `collected` messages still to send, before the parts (day 4: the ids the document has collected). */
    readonly collected: string[];
  } | null;
}

/** The server's replica id. It never makes an element, so it never names one. */
const SERVER_REPLICA = 'server';

export class DocumentHub {
  readonly doc: string;
  readonly #rga: Rga;
  /**
   * The log kept in memory: entry n is `#log[n - #base - 1]`, as encodeOp wrote it. With a store, entries before the
   * previous snapshot are dropped, and #base is the last one dropped; a member that has applied less gets a snapshot.
   */
  #log: string[] = [];
  #base = 0;
  /** The entry the last snapshot written is the state after (0: none). */
  #snapshotSeq = 0;
  readonly #store: DocumentStore | null = null;
  readonly #snapshotEvery: number;
  readonly #collect: boolean;
  /** The sequence number at which the next snapshot is written: an interval after the last one, or after a failure. */
  #snapshotDue = 0;
  /** Set when storing an entry failed: the replica holds operations the disk may not, so the hub must go. */
  #broken = false;
  /** Joined members: each one's cursor, and where its catch-up has got to. */
  readonly #members = new Map<Member, MemberState>();

  /**
   * A hub for `doc`, with what its store holds if it has one: the newest snapshot applied, then the entries after
   * it. Throws StoreError for a document whose files don't read back (or don't rebuild a valid document), and
   * whatever the file system throws.
   */
  constructor(doc: string, options: HubOptions = {}) {
    this.doc = doc;
    this.#rga = new Rga(
      SERVER_REPLICA,
      options.capacity === undefined ? {} : { capacity: options.capacity },
    );
    this.#snapshotEvery = options.snapshotEvery ?? 10_000;
    this.#collect = options.collect ?? true;
    if (options.store === undefined) return;
    const { store, loaded } = DocumentStore.open(options.store.root, doc, options.store);
    try {
      // stamp(i): the stamp of the i-th operation (Rga.apply), by which collection goes.
      const rebuild = (
        texts: readonly string[],
        what: string,
        ready: boolean,
        stamp: (i: number) => number,
      ) => {
        for (let i = 0; i < texts.length; i++) {
          const op = JSON.parse(texts[i] as string) as Op;
          if (ready && !this.#rga.ready(op)) {
            throw new StoreError(
              store.dir,
              `${what} ${i + 1}: its dependencies aren't in the document`,
            );
          }
          try {
            this.#rga.apply(op, stamp(i));
          } catch (error) {
            throw new StoreError(store.dir, `${what} ${i + 1}: ${(error as Error).message}`);
          }
        }
      };
      const snapshot = loaded.snapshot;
      if (snapshot !== null) {
        try {
          this.#rga.markCollected(snapshot.collected);
        } catch (error) {
          throw new StoreError(
            store.dir,
            `the snapshot's collected ids: ${(error as Error).message}`,
          );
        }
        // Its tombstones were deleted at or before it: stamped with its sequence number.
        rebuild(snapshot.ops, `the snapshot's operation`, false, () => snapshot.seq);
        if (this.#rga.pending > 0) {
          throw new StoreError(store.dir, "the snapshot's operations leave some waiting");
        }
        this.#snapshotSeq = snapshot.seq;
      }
      const skip = Math.max(0, this.#snapshotSeq - loaded.first + 1);
      rebuild(
        loaded.entries.slice(skip),
        'log entry after the snapshot',
        true,
        (i) => loaded.first + skip + i,
      );
    } catch (error) {
      store.close();
      throw error;
    }
    this.#store = store;
    this.#log = [...loaded.entries];
    this.#base = loaded.first - 1;
    this.#snapshotDue = this.#snapshotSeq + this.#snapshotEvery;
  }

  /** The last sequence number in the log (0 when it's empty). */
  get seq(): number {
    return this.#base + this.#log.length;
  }

  /** The oldest log entry kept, less one: a member that has applied less gets a snapshot instead of the log. */
  get base(): number {
    return this.#base;
  }

  /** Whether storing an entry failed: the hub refuses everything, and the server must drop it and load it again. */
  get broken(): boolean {
    return this.#broken;
  }

  /** Closes the store (the hub can't take operations after). */
  close(): void {
    this.#store?.close();
  }

  /** The document's text, as the server's replica holds it. */
  text(): string {
    return this.#rga.text();
  }

  /** The server replica's state (Rga.state), for tests comparing it with the clients'. */
  state(): string {
    return this.#rga.state();
  }

  get members(): number {
    return this.#members.size;
  }

  /**
   * Joins a member that has applied the log up to `have`: sends `welcome`, then the entries after `have` up to the
   * end of the log, however far it has got by then (#catchUp), then the other members' cursors, and relays to it from
   * then on. A member already joined with the same replica id is replaced (a client reconnecting before the server
   * noticed its old connection drop).
   */
  join(member: Member, have: number): Refusal | null {
    if (this.#broken) return failed();
    if (have > this.seq) {
      return {
        code: 'ahead-of-server',
        message: `you have applied ${have} log entries, but this server's log of ${this.doc} has ${this.seq}: it has lost entries you have (restarted without its data?)`,
      };
    }
    for (const other of this.#members.keys()) {
      if (other.replica === member.replica) {
        this.leave(other);
        other.replace();
      }
    }
    member.send(
      encodeServerMessage({
        type: 'welcome',
        protocol: PROTOCOL_VERSION,
        doc: this.doc,
        seq: this.seq,
      }),
    );
    // Too far behind for the log kept, or asking for everything (`have` 0: a fresh client, or one resyncing) where
    // elements have been collected: the document as it is now, then the log from here on.
    const state: MemberState =
      have < this.#base || (have === 0 && this.#rga.sizes().collected > 0)
        ? {
            cursor: null,
            next: this.seq + 1,
            snapshot: {
              seq: this.seq,
              ops: this.#rga.snapshot().map(encodeOp),
              at: 0,
              collected: collectedMessages(this.#rga.collectedSpans()),
            },
          }
        : { cursor: null, next: have + 1, snapshot: null };
    this.#members.set(member, state);
    this.#catchUp(member, state);
    return null;
  }

  /**
   * Sends a joining member the log from `state.next` on, one batch at a time, each once the one before has been
   * written out, so a member reading as fast as it can is never dropped as a slow reader however long the log (the
   * review of day 3 found that writing it all at once did, at about 16 MiB of log). Entries logged meanwhile are sent
   * the same way, and nothing else is sent to it until it reaches the end (no live ops, presence or leaves: those
   * would count against the slow-reader limit with a batch in flight); then it gets the cursors shown and live
   * relays. Each batch is found by measuring only the entries it holds (batchEnd).
   */
  #catchUp(member: Member, state: MemberState): void {
    for (;;) {
      if (this.#members.get(member) !== state) return; // left, or replaced
      let text: string;
      const snapshot = state.snapshot;
      const next = state.next as number;
      if (snapshot !== null && snapshot.collected.length > 0) {
        text = snapshot.collected.shift() as string;
      } else if (snapshot !== null) {
        const end = batchEnd(snapshot.ops, snapshot.at);
        const last = end === snapshot.ops.length;
        text = encodeServerSnapshot(snapshot.seq, snapshot.ops.slice(snapshot.at, end), last);
        snapshot.at = end;
        if (last) state.snapshot = null;
      } else if (next > this.seq) {
        state.next = null;
        for (const [other, { cursor }] of this.#members) {
          if (other !== member && cursor !== null) {
            member.send(encodeServerMessage({ type: 'presence', replica: other.replica, cursor }));
          }
        }
        return;
      } else {
        const start = next - this.#base - 1;
        const batch = this.#log.slice(start, batchEnd(this.#log, start));
        state.next = next + batch.length;
        text = encodeServerOps(next, batch);
      }
      // Whether the send has called back yet, and whether this loop is still inside the send (a member that writes
      // synchronously calls back from within it: then the loop carries on, rather than recurse).
      const progress = { inside: true, written: false };
      member.send(text, () => {
        progress.written = true;
        if (!progress.inside) this.#catchUp(member, state);
      });
      progress.inside = false;
      if (!progress.written) return;
    }
  }

  /**
   * Removes a member (its connection closed, or a newer one replaced it); the others see its cursor go. Sent even
   * if it never showed one: the protocol says a client that disconnects gets `cursor: null`. A replaced client
   * sends its cursor again on its new connection.
   */
  leave(member: Member): void {
    if (!this.#members.delete(member)) return;
    const text = encodeServerMessage({ type: 'presence', replica: member.replica, cursor: null });
    // Members still catching up get the cursors shown when they reach the end of the log: a relay to them now would
    // count against the slow-reader limit with a catch-up batch still in flight (review 2 of day 3).
    for (const [other, state] of this.#members) if (state.next === null) other.send(text);
  }

  /**
   * Applies a member's operations in order, logs each new one, and relays them to every member (the sender
   * included). An insert the server already holds (a client resending its outbox after a reconnect) isn't logged
   * again: its first copy was or will be echoed to the sender. A delete is logged every time it comes, even when it
   * changes nothing, since its sender waits for an echo of it; a repeated delete changes nothing anywhere.
   *
   * At the first operation it refuses it stops: the ones before it are logged and relayed, and the refusal is
   * returned for the server to send before closing the connection.
   */
  submit(member: Member, ops: readonly Op[]): Refusal | null {
    if (this.#broken) return failed();
    if (!this.#members.has(member))
      throw new Error(`${member.replica} isn't joined to ${this.doc}`);
    const from = this.seq + 1;
    let refusal: Refusal | null = null;
    // Ids named by this message's deletes so far. The overlap rule bounds one delete's cost by the document's size,
    // but a message carries up to 1,000 deletes, which could each name the whole document: 3.9 s for one message of a
    // 200,000-character document (review 2 of day 3). A client deletes each element at most once, so the deletes of
    // one honest message name at most as many ids as the document holds.
    let named = 0;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] as Op;
      try {
        // An element collected since its sender saw it (DESIGN.md "Tombstones"): the sender rebuilds from a snapshot
        // and sends its edits again. Refusing it for good would stop an honest client that was offline a while.
        if (this.#rga.namesCollected(op)) {
          refusal = refused(i, 'it names an element this document has collected', 'resync');
          break;
        }
        const problem = this.#check(op, member);
        if (problem !== null) {
          refusal = refused(i, problem);
          break;
        }
        if (op.type === 'delete') {
          for (const span of op.spans) named += span.length;
          const held = this.#rga.sizes().elements;
          if (named > held) {
            refusal = refused(
              i,
              `this message's deletes name ${named} ids, more than the ${held} elements of this document`,
            );
            break;
          }
        }
        const duplicate = op.type === 'insert' && this.#rga.has(op.id);
        // Stamped with the entry it becomes (a delete always becomes one), for collection.
        this.#rga.apply(op, this.seq + 1);
        if (!duplicate) this.#log.push(encodeOp(op));
      } catch (error) {
        // RangeError: the document is full (the replica's capacity). ProtocolError only for operations that didn't
        // come through the decoder.
        if (error instanceof RangeError) refusal = refused(i, error.message, 'too-large');
        else if (error instanceof ConflictError || error instanceof ProtocolError) {
          refusal = refused(i, error.message);
        } else throw error;
        break;
      }
    }
    const added = this.#log.slice(from - this.#base - 1);
    // On disk before anyone sees them: whatever a client has applied, the server has kept.
    if (this.#store !== null && added.length > 0) {
      try {
        this.#store.append(from, added);
      } catch (error) {
        return this.#fail(error, member);
      }
    }
    let next = from;
    for (const batch of batchOps(added)) {
      const text = encodeServerOps(next, batch);
      // A member still catching up gets these from the log, in order, when its catch-up reaches them.
      for (const [other, state] of this.#members) if (state.next === null) other.send(text);
      next += batch.length;
    }
    if (this.#store !== null && this.seq >= this.#snapshotDue) this.#takeSnapshot(this.#store);
    return refusal;
  }

  /**
   * Writes a snapshot after the last entry, and drops the entries before the previous snapshot from disk and from
   * memory, except those a member still catching up hasn't been sent. A snapshot that fails to write loses
   * nothing (the log has every entry), so the hub goes on, and tries again an interval later, not at every message
   * (review of day 4: a failure that lasted wrote a whole copy of the document per keystroke).
   */
  #takeSnapshot(store: DocumentStore): void {
    this.#snapshotDue = this.seq + this.#snapshotEvery;
    let keepFrom = this.#snapshotSeq + 1;
    for (const { next } of this.#members.values()) {
      if (next !== null) keepFrom = Math.min(keepFrom, next);
    }
    try {
      // Tombstones whose last delete is in an entry this snapshot lets go of: every client that will catch up from
      // the log has applied it, and one further behind gets a snapshot (DESIGN.md "Tombstones").
      // The replica changes only once the snapshot of it after the collection is on disk: a write that fails leaves it
      // as a reload would rebuild it (review of the collection).
      const write = (after: { readonly ops: Op[]; readonly collected: Span[] }) => {
        store.snapshot(after.ops.map(encodeOp), keepFrom, after.collected);
      };
      if (this.#collect) this.#rga.collect(keepFrom - 1, write);
      else write({ ops: this.#rga.snapshot(), collected: this.#rga.collectedSpans() });
    } catch (error) {
      console.error(`coedit: writing a snapshot of ${this.doc} failed`, error);
      return;
    }
    this.#snapshotSeq = this.seq;
    const drop = keepFrom - 1 - this.#base;
    if (drop > 0) {
      this.#log = this.#log.slice(drop);
      this.#base += drop;
    }
  }

  /**
   * Storing entries failed (a full disk): they're applied to the replica but may not be on disk, and they haven't
   * been relayed. The hub can't go on without the disk and the replica disagreeing, so it closes the store and
   * every member's connection (`server-error`, which clients retry); the server drops it, and the next join loads the
   * document again from what reached the disk. The sender keeps the operations in its outbox and resends them.
   */
  #fail(error: unknown, sender: Member): Refusal {
    this.#broken = true;
    console.error(`coedit: storing log entries of ${this.doc} failed; closing it`, error);
    try {
      this.#store?.close();
    } catch {
      // Already failing; the store's file descriptor goes with the process at worst.
    }
    const refusal = failed();
    const members = [...this.#members.keys()];
    this.#members.clear();
    for (const other of members) if (other !== sender) other.fail(refusal);
    return refusal;
  }

  /** Why the server can't accept `op` from `member` now, or null. */
  #check(op: Op, member: Member): string | null {
    const rga = this.#rga;
    // A replica only makes ids under its own replica id. One inserting under another's could take that replica's
    // next ids first, and that replica's next edit would then be refused as a conflict, stopping it (review of day
    // 3). Deletes may name anyone's ids.
    if (op.type === 'insert' && op.id.replica !== member.replica) {
      return `it inserts under replica ${op.id.replica}, but this connection is ${member.replica}`;
    }
    // Applying a delete costs a lookup per id named, and the wire format lets all 1,000 spans name the same 10,000
    // ids: 10 million lookups for one 43 KB operation, and 23 of those in one message kept the server from every
    // other client for about 5 s (review of day 3). No replica writes overlapping spans (Rga.edit's are disjoint).
    // Without overlaps every id named is a distinct element placed here, so a delete's cost is bounded by the
    // document's size.
    if (op.type === 'delete' && overlapping(op.spans)) return 'its spans overlap';
    if (!rga.ready(op)) {
      return op.type === 'insert'
        ? `its origin ${formatId(op.origin)} isn't an element of this document`
        : "it deletes ids that aren't elements of this document";
    }
    if (op.type === 'insert') {
      // Every replica's clock takes the largest counter it receives, so one insert numbered near 2^53 - 1 would use
      // up every clock for good. An honest client's counters are at most the server's clock (it has seen nothing
      // newer) plus the elements it made since, which its capacity bounds; so the server refuses an insert ending
      // more than its own capacity past its clock. Then each insert moves the clock at most a capacity on, an insert
      // makes at least one element, and the server holds at most a capacity of them: the clock stays below
      // capacity squared (2^46), and can't run out before the document is full.
      const last = op.id.counter + codePoints(op.text) - 1;
      if (last > rga.clock + rga.capacity) {
        return `its counters end at ${last}, more than ${rga.capacity} past this document's clock (${rga.clock})`;
      }
    }
    return null;
  }

  /** Relays a member's cursor to the others, and keeps it for members who join later. */
  presence(member: Member, cursor: Cursor | null): void {
    if (!this.#members.has(member))
      throw new Error(`${member.replica} isn't joined to ${this.doc}`);
    (this.#members.get(member) as MemberState).cursor = cursor;
    const text = encodeServerMessage({ type: 'presence', replica: member.replica, cursor });
    for (const [other, state] of this.#members) {
      if (other !== member && state.next === null) other.send(text);
    }
  }
}

/** Whether two of the spans name the same id. */
function overlapping(spans: readonly Span[]): boolean {
  const sorted = [...spans].sort((a, b) =>
    a.replica === b.replica ? a.counter - b.counter : a.replica < b.replica ? -1 : 1,
  );
  for (let i = 1; i < sorted.length; i++) {
    const before = sorted[i - 1] as Span;
    const span = sorted[i] as Span;
    if (before.replica === span.replica && span.counter - before.counter < before.length)
      return true;
  }
  return false;
}

/** `collected` messages for `spans`, at most MAX_SPANS spans each. */
function collectedMessages(spans: readonly Span[]): string[] {
  const messages: string[] = [];
  for (let i = 0; i < spans.length; i += MAX_SPANS) {
    messages.push(encodeServerMessage({ type: 'collected', spans: spans.slice(i, i + MAX_SPANS) }));
  }
  return messages;
}

function failed(): Refusal {
  return {
    code: 'server-error',
    message: "the server couldn't store this document's log: reconnect to load it again",
  };
}

function refused(index: number, problem: string, code: ErrorCode = 'refused-op'): Refusal {
  return { code, message: truncate(`ops[${index}] refused: ${problem}`) };
}

/** A message cut to the protocol's limit for error messages, in code points. */
export function truncate(message: string): string {
  if (codePoints(message) <= MAX_ERROR_MESSAGE_LENGTH) return message;
  return `${Array.from(message)
    .slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)
    .join('')}…`;
}
