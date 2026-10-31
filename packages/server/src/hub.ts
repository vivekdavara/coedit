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
  MAX_OPS,
  PROTOCOL_VERSION,
  ProtocolError,
  Rga,
  batchOps,
  codePoints,
  encodeOp,
  encodeServerMessage,
  encodeServerOps,
  formatId,
  type Cursor,
  type ErrorCode,
  type Op,
  type Span,
} from '@coedit/crdt';

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
}

/** Why the hub refused a join or an operation: the error message to send before closing the connection. */
export interface Refusal {
  readonly code: ErrorCode;
  readonly message: string;
}

export interface HubOptions {
  /** The server replica's capacity (Rga's); tests set it small. */
  readonly capacity?: number;
}

interface MemberState {
  /** Its cursor; null until it sends one, or after it hides it. */
  cursor: Cursor | null;
  /** The next log entry its catch-up sends; null once caught up and receiving live relays. */
  next: number | null;
}

/** The server's replica id. It never makes an element, so it never names one. */
const SERVER_REPLICA = 'server';

export class DocumentHub {
  readonly doc: string;
  readonly #rga: Rga;
  /** The log: entry n (from 1) is `#log[n - 1]`, as encodeOp wrote it. */
  readonly #log: string[] = [];
  /** Joined members: each one's cursor, and where its catch-up has got to. */
  readonly #members = new Map<Member, MemberState>();

  constructor(doc: string, options: HubOptions = {}) {
    this.doc = doc;
    this.#rga = new Rga(
      SERVER_REPLICA,
      options.capacity === undefined ? {} : { capacity: options.capacity },
    );
  }

  /** The last sequence number in the log (0 when it's empty). */
  get seq(): number {
    return this.#log.length;
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
   * Joins a member that has applied the log up to `have`: sends `welcome`, the entries after `have`, and the
   * other members' cursors, then relays to it from then on. A member already joined with the same replica id is
   * replaced (a client reconnecting before the server noticed its old connection drop).
   */
  join(member: Member, have: number): Refusal | null {
    if (have > this.#log.length) {
      return {
        code: 'ahead-of-server',
        message: `you have applied ${have} log entries, but this server's log of ${this.doc} has ${this.#log.length}: it has lost entries you have (restarted without its data?)`,
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
        seq: this.#log.length,
      }),
    );
    const state: MemberState = { cursor: null, next: have + 1 };
    this.#members.set(member, state);
    this.#catchUp(member, state);
    return null;
  }

  /**
   * Sends a joining member the log from `state.next` on, one batch at a time, each once the one before has been
   * written out, so a member reading as fast as it can is never dropped as a slow reader however long the log (the
   * review of day 3 found that writing it all at once did, at about 16 MiB of log). Entries logged meanwhile are sent
   * the same way. When it reaches the end, the member gets the cursors shown and live relays from then on.
   */
  #catchUp(member: Member, state: MemberState): void {
    for (;;) {
      if (this.#members.get(member) !== state) return; // left, or replaced
      const next = state.next as number;
      if (next > this.#log.length) {
        state.next = null;
        for (const [other, { cursor }] of this.#members) {
          if (other !== member && cursor !== null) {
            member.send(encodeServerMessage({ type: 'presence', replica: other.replica, cursor }));
          }
        }
        return;
      }
      const batch = batchOps(this.#log.slice(next - 1, next - 1 + MAX_OPS))[0] as string[];
      state.next = next + batch.length;
      // Whether the send has called back yet, and whether this loop is still inside the send (a member that writes
      // synchronously calls back from within it: then the loop carries on, rather than recurse).
      const progress = { inside: true, written: false };
      member.send(encodeServerOps(next, batch), () => {
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
    for (const other of this.#members.keys()) other.send(text);
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
    if (!this.#members.has(member))
      throw new Error(`${member.replica} isn't joined to ${this.doc}`);
    const from = this.#log.length + 1;
    let refusal: Refusal | null = null;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] as Op;
      try {
        const problem = this.#check(op, member);
        if (problem !== null) {
          refusal = refused(i, problem);
          break;
        }
        const duplicate = op.type === 'insert' && this.#rga.has(op.id);
        this.#rga.apply(op);
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
    let next = from;
    for (const batch of batchOps(this.#log.slice(from - 1))) {
      const text = encodeServerOps(next, batch);
      // A member still catching up gets these from the log, in order, when its catch-up reaches them.
      for (const [other, state] of this.#members) if (state.next === null) other.send(text);
      next += batch.length;
    }
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
    for (const other of this.#members.keys()) if (other !== member) other.send(text);
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
