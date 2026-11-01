/**
 * The sync client: one tab's replica of a document, kept in step with the server over a WebSocket (DESIGN.md "The
 * sync protocol" and "The client"). No React here: the editor calls `edit` and `select`, and listens for remote
 * changes, presence and status. It runs in Node too (Node 22 has a WebSocket), which is how it's tested.
 *
 * - **The outbox.** A local edit is applied to the replica at once and its operations go in the outbox, in order.
 *   They leave the outbox when the server echoes them back (the echo is the acknowledgement): the server relays
 *   each client's operations in the order it sent them, so echoes arrive in outbox order, and the first operation
 *   in the outbox is the only one an echo can match. Operations are compared by their canonical text.
 * - **Reconnect.** The client remembers the last sequence number it applied. On each connection it sends `hello`
 *   with it, applies what it missed (up to the `seq` in `welcome`), and only then sends its outbox, all of it, in
 *   batches: whatever was echoed by then has left the outbox, so what is resent is what the server hadn't logged
 *   when this client joined. An insert the server already had (sent just before a connection dropped) is
 *   recognized and not logged twice; a delete is logged again, which changes nothing anywhere. A client too far
 *   behind gets a snapshot instead of the log (day 4): what the snapshot holds leaves the outbox unsent, including
 *   a delete the server never logged whose ids someone else had already deleted (it would change nothing).
 * - **Errors.** A connection that closes is retried with exponential backoff and jitter. An `error` message other
 *   than `server-error` means retrying would be refused the same way, so the client stops (status `failed`).
 */
import {
  CollectedError,
  ConflictError,
  MAX_SPANS,
  ProtocolError,
  Rga,
  batchOps,
  decodeServerMessage,
  encodeClientMessage,
  encodeClientOps,
  encodeOp,
  formatId,
  sameId,
  type Change,
  type Cursor,
  type Id,
  type Op,
  type ServerMessage,
  type Span,
} from '@coedit/crdt';
import { diffText } from './edit.ts';

/**
 * - `connecting`: opening a connection; `syncing`: joined, applying what was missed; `online`: caught up, edits
 *   go out as they're made; `offline`: waiting to reconnect (edits wait in the outbox); `failed`: stopped for good
 *   (`detail` says why); `stopped`: stop() was called.
 */
export type Status = 'connecting' | 'syncing' | 'online' | 'offline' | 'failed' | 'stopped';

/** A selection in code points: where it started and where the caret is. */
export interface Selection {
  readonly anchor: number;
  readonly head: number;
}

export interface SyncEvents {
  /** Remote operations changed the visible text: apply these in order. */
  onChanges?(changes: readonly Change[]): void;
  onStatus?(status: Status, detail: string): void;
  /** Someone's cursor moved, appeared or went (call remoteSelections for where they are now). */
  onPresence?(): void;
  /** Log entries were applied or echoes acknowledged: `seq` and `unacknowledged` may have changed. */
  onProgress?(): void;
}

/** The parts of the browser's WebSocket the client uses; tests and Node pass their own. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface SyncOptions {
  /** The sync endpoint, e.g. `ws://127.0.0.1:8110/sync`. */
  readonly url: string;
  readonly doc: string;
  /** This replica's id; default 16 random bytes in base64url. Two clients must never share one. */
  readonly replica?: string;
  /** Opens a socket; default the global WebSocket. */
  readonly connect?: (url: string) => SocketLike;
  /** Reconnect backoff: the first delay and the most (default 250 ms and 10 s), doubled per failed attempt. */
  readonly backoffMs?: { readonly initial: number; readonly max: number };
  /** For the jitter (default Math.random). */
  readonly random?: () => number;
  /** The replica's capacity (Rga's); tests set it small. */
  readonly capacity?: number;
}

const OPEN = 1;

interface Outgoing {
  readonly op: Op;
  /** encodeOp's text, which the echo is compared with. */
  readonly text: string;
}

export class SyncClient {
  readonly doc: string;
  readonly replica: string;
  /** The replica; a snapshot replaces it with one built from the server's document (day 4). */
  #rga: Rga;
  readonly #capacity: number | undefined;
  readonly #url: string;
  readonly #connect: (url: string) => SocketLike;
  readonly #events: SyncEvents;
  readonly #backoff: { readonly initial: number; readonly max: number };
  readonly #random: () => number;

  /** The last log sequence number applied. */
  #seq = 0;
  /** Local operations the server hasn't echoed yet, oldest first. */
  #outbox: Outgoing[] = [];
  #socket: SocketLike | null = null;
  /** The log's end when the current connection joined; null until `welcome`. */
  #target: number | null = null;
  #live = false;
  #status: Status = 'stopped';
  #detail = '';
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** This client's selection as ids (what it last sent or will send), and everyone else's. */
  #cursor: Cursor | null = null;
  readonly #remote = new Map<string, Cursor>();
  /** While hold() is on: `ops`, `snapshot` and `collected` messages received and not yet applied. */
  #held: (ServerMessage & { type: 'ops' | 'snapshot' | 'collected' })[] | null = null;
  /**
   * A snapshot being received: the collected ids that came before its parts, and the replica being built from them
   * (null until the first part). Swapped in at the last part (#rebuild).
   */
  #snapshot: { rga: Rga | null; collected: Span[] } | null = null;
  /**
   * Set by a `resync` error (an operation of ours named an element the server has collected): the next hello asks
   * for everything (`have: 0`), which such a document answers with a snapshot to rebuild from.
   */
  #resync = false;

  constructor(options: SyncOptions, events: SyncEvents = {}) {
    this.doc = options.doc;
    this.replica = options.replica ?? randomReplica();
    this.#capacity = options.capacity;
    this.#rga = new Rga(this.replica, this.#rgaOptions(0));
    this.#url = options.url;
    this.#connect = options.connect ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.#events = events;
    this.#backoff = options.backoffMs ?? { initial: 250, max: 10_000 };
    this.#random = options.random ?? Math.random;
  }

  get status(): Status {
    return this.#status;
  }

  /** Why the client failed, or what it is waiting for. */
  get detail(): string {
    return this.#detail;
  }

  /** The replica (replaced when the client rebuilds from a snapshot). */
  get rga(): Rga {
    return this.#rga;
  }

  /** The last log sequence number applied. */
  get seq(): number {
    return this.#seq;
  }

  /** Local operations not yet echoed by the server. */
  get unacknowledged(): number {
    return this.#outbox.length;
  }

  /** Starts connecting (and reconnecting whenever the connection drops) until stop(). */
  start(): void {
    if (this.#status !== 'stopped') return;
    this.#open();
  }

  /** Closes the connection and stops reconnecting. Edits still apply locally. */
  stop(): void {
    clearTimeout(this.#timer);
    const socket = this.#socket;
    this.#drop();
    this.#setStatus('stopped', '');
    socket?.close(1000, 'stopped');
  }

  /**
   * Drops the connection as a network failure would, and reconnects after the usual backoff (for tests; the
   * editor's "Go offline" switch uses stop() and start()).
   */
  disconnect(): void {
    const socket = this.#socket;
    if (socket === null) return;
    this.#drop();
    socket.close(1000, 'disconnected');
    this.#retry('disconnected');
  }

  /**
   * A local edit, in code points: applied to the replica at once and queued for the server (sent now if online).
   * Throws RangeError as Rga.edit does (a position outside the text, the replica full).
   */
  edit(index: number, deleteCount: number, text: string): void {
    const ops = this.#rga.edit(index, deleteCount, text);
    const first = this.#outbox.length;
    for (const op of ops) this.#outbox.push({ op, text: encodeOp(op) });
    if (this.#live) this.#flush(first);
  }

  /**
   * Holds remote operations: received, not applied, until release(). For an IME composition, while the browser
   * owns the textarea: the edit made when it ends is found against the text from before it, so the replica must
   * still hold that text then. Edits made meanwhile apply and are sent as usual.
   */
  hold(): void {
    this.#held ??= [];
  }

  /** Applies what hold() kept, in order, and stops holding. */
  release(): void {
    const held = this.#held;
    this.#held = null;
    for (const message of held ?? []) {
      if (this.#status === 'failed') return;
      this.#receive(message);
    }
  }

  /** This client's selection moved (code points), or null: hidden. Sent to the others when it changes. */
  select(selection: Selection | null): void {
    const cursor =
      selection === null
        ? null
        : {
            anchor: this.#rga.idBefore(selection.anchor),
            head: this.#rga.idBefore(selection.head),
          };
    if (sameCursor(cursor, this.#cursor)) return;
    this.#cursor = cursor;
    if (this.#live) this.#send(encodeClientMessage({ type: 'presence', cursor }));
  }

  /**
   * Everyone else's selection, in code points of this replica's text now. A cursor after an element this replica
   * hasn't received yet is left out until it arrives.
   */
  remoteSelections(): Map<string, Selection> {
    const selections = new Map<string, Selection>();
    for (const [replica, cursor] of this.#remote) {
      const anchor = this.#rga.indexAfter(cursor.anchor);
      const head = this.#rga.indexAfter(cursor.head);
      if (anchor !== undefined && head !== undefined) selections.set(replica, { anchor, head });
    }
    return selections;
  }

  #open(): void {
    this.#setStatus('connecting', '');
    let socket: SocketLike;
    try {
      socket = this.#connect(this.#url);
    } catch (error) {
      this.#retry(`can't connect: ${(error as Error).message}`);
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#setStatus('syncing', '');
      this.#send(
        encodeClientMessage({
          type: 'hello',
          protocol: 1,
          doc: this.doc,
          replica: this.replica,
          have: this.#resync ? 0 : this.#seq,
        }),
      );
    };
    socket.onmessage = (event) => {
      if (this.#socket !== socket) return;
      if (typeof event.data !== 'string') {
        this.#fail('the server sent a binary message');
        return;
      }
      let message: ServerMessage;
      try {
        message = decodeServerMessage(event.data);
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        this.#fail(`the server sent a message the protocol doesn't allow: ${error.message}`);
        return;
      }
      this.#receive(message);
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#drop();
      this.#retry(event.code === 1006 ? 'connection lost' : `closed (${event.code})`);
    };
    // A browser follows an error with a close, but Node's WebSocket (23.11) doesn't after a refused connection: it
    // fires error and stays CONNECTING for good. So an error drops the socket itself; a close after it is ignored.
    socket.onerror = () => {
      if (this.#socket !== socket) return;
      this.#drop();
      socket.close();
      this.#retry('connection failed');
    };
  }

  #receive(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome': {
        if (message.doc !== this.doc || this.#target !== null) {
          this.#fail(`unexpected welcome to ${message.doc}`);
          return;
        }
        if (message.seq < this.#seq) {
          // The server would have refused the hello with ahead-of-server; a welcome like this is its bug.
          this.#fail(
            `the server's log ends at ${message.seq}, before the ${this.#seq} entries applied here`,
          );
          return;
        }
        this.#attempt = 0;
        this.#target = message.seq;
        // Resyncing, a snapshot follows even when nothing is new.
        if (this.#seq === message.seq && !this.#resync) this.#goLive();
        return;
      }
      case 'ops': {
        if (this.#held !== null) {
          this.#held.push(message);
          return;
        }
        if (this.#target === null || message.from !== this.#seq + 1) {
          this.#fail(`log entries from ${message.from}, but ${this.#seq} were applied`);
          return;
        }
        const changes: Change[] = [];
        for (const op of message.ops) {
          const head = this.#outbox[0];
          if (head !== undefined && head.text === encodeOp(op)) {
            // Its echo: applied here already.
            this.#outbox.shift();
          } else {
            try {
              for (const change of this.#rga.apply(op)) changes.push(change);
            } catch (error) {
              // CollectedError: an entry naming an element this replica (rebuilt from a snapshot) holds as collected.
              if (!(
                error instanceof ConflictError ||
                error instanceof RangeError ||
                error instanceof CollectedError
              )) {
                throw error;
              }
              this.#fail(`this replica refuses log entry ${this.#seq + 1}: ${error.message}`);
              if (changes.length > 0) this.#events.onChanges?.(changes);
              return;
            }
          }
          this.#seq++;
        }
        if (changes.length > 0) this.#events.onChanges?.(changes);
        if (!this.#live && this.#seq >= this.#target) this.#goLive();
        if (this.#remote.size > 0) this.#events.onPresence?.();
        this.#events.onProgress?.();
        return;
      }
      case 'snapshot': {
        if (this.#held !== null) {
          this.#held.push(message);
          return;
        }
        // Only during a catch-up, of the document as it was at most when this connection joined.
        if (
          this.#target === null ||
          this.#live ||
          message.seq < this.#seq ||
          message.seq > this.#target
        ) {
          this.#fail(`a snapshot after entry ${message.seq}, with ${this.#seq} applied`);
          return;
        }
        const pending = (this.#snapshot ??= { rga: null, collected: [] });
        if (pending.rga === null) {
          // A new replica, with this one's clock so its next ids stay new (some of its own may be collected).
          pending.rga = new Rga(this.replica, this.#rgaOptions(this.#rga.clock));
          try {
            pending.rga.markCollected(pending.collected);
          } catch (error) {
            if (!(error instanceof RangeError)) throw error;
            this.#fail(`the snapshot's collected ids: ${error.message}`);
            return;
          }
        }
        for (const op of message.ops) {
          try {
            pending.rga.apply(op);
          } catch (error) {
            if (!(
              error instanceof ConflictError ||
              error instanceof RangeError ||
              error instanceof CollectedError
            )) {
              throw error;
            }
            this.#fail(`the snapshot doesn't build a replica: ${error.message}`);
            return;
          }
        }
        if (!message.last) return;
        this.#snapshot = null;
        this.#rebuild(pending.rga, message.seq);
        return;
      }
      case 'collected': {
        if (this.#held !== null) {
          this.#held.push(message);
          return;
        }
        // Only before a snapshot's parts.
        if (this.#target === null || this.#live || this.#snapshot?.rga != null) {
          this.#fail('collected ids outside the start of a snapshot');
          return;
        }
        const pending = (this.#snapshot ??= { rga: null, collected: [] });
        for (const span of message.spans) pending.collected.push(span);
        return;
      }
      case 'presence': {
        if (message.replica === this.replica) return;
        if (message.cursor === null) this.#remote.delete(message.replica);
        else this.#remote.set(message.replica, message.cursor);
        this.#events.onPresence?.();
        return;
      }
      case 'error': {
        if (message.code === 'resync') {
          // Closing follows; the next connection asks for a snapshot and sends our edits again against it.
          this.#resync = true;
          this.#detail = message.message;
          return;
        }
        if (message.code === 'server-error') {
          // Closing follows; retrying may work.
          this.#detail = message.message;
          return;
        }
        this.#fail(`${message.code}: ${message.message}`);
        return;
      }
    }
  }

  /**
   * Replaces the replica with `fresh`, built from a snapshot of the server's document after entry `seq` (DESIGN.md
   * "Persistence (day 4)", "Tombstones"), and goes over the outbox against it, in order. The snapshot holds what the
   * server had logged by `seq`, its collected ids included, so: an insert whose ids it holds or collected was logged
   * (its echo was in the entries the snapshot replaces) and leaves the outbox; a delete all of whose ids are its
   * tombstones or collected has its effect there already and leaves too. The rest were never logged: applied to the
   * new replica and kept, a delete without the collected ids it named (they're deleted). From the first unsent insert
   * whose origin was collected on, every unsent insert is re-issued under a new id, right after the element before
   * it in the order a server that never collected would give (placeUnsent), and later deletes and this client's
   * cursor are renamed to match; none of them was ever logged (the server refuses an insert naming a collected
   * element, and a client sends in order), so no one has seen the old ids, and the new ones may reuse their counters.
   * The text, and its place among the text the snapshot holds, are what they would have been without collection.
   * Text logged after the snapshot at the same spot is concurrent with the re-issued insert and may land on its
   * other side (release review, round 2): RGA puts the newer first, and every replica agrees. The editor gets the
   * difference between the two texts.
   */
  #rebuild(fresh: Rga, seq: number): void {
    const old = this.#rga;
    // Set at the first unsent insert whose origin was collected: from it on, every unsent insert is re-issued.
    let place: Placement | null = null;
    const renamed = new Map<string, Id>();
    let counter = 0;
    const outbox: Outgoing[] = [];
    for (let k = 0; k < this.#outbox.length; k++) {
      const { op, text } = this.#outbox[k] as Outgoing;
      let next: Op = op;
      if (op.type === 'insert') {
        // (Not once re-issuing: nothing from there on was logged, and a new id may reuse an old one's counter.)
        if (place === null && (fresh.has(op.id) || fresh.isCollected(op.id))) continue;
        if (place === null && op.origin !== null && !fresh.has(op.origin)) {
          if (!fresh.isCollected(op.origin)) {
            this.#fail(`the snapshot lacks ${formatId(op.origin)}, which an unsent edit is after`);
            return;
          }
          const placed = placeUnsent(old, fresh, this.#outbox.slice(k));
          if (typeof placed === 'string') {
            this.#fail(placed);
            return;
          }
          place = placed;
          counter = placed.above + 1;
        }
        if (place !== null) {
          // Re-issued under a new id, larger than every id in the new replica, so it lands right after its new origin:
          // the nearest element before it, in the never-collecting order, that the new replica holds by now (release
          // review: anchoring at a collected origin's position by RGA's scan reordered two inserts after it, and
          // falling back to a smaller counter crossed visible text). No one has seen its old id: it was never logged.
          // The counters go on from what the new replica held, not from this client's clock, which counts the old
          // ids too: from there an unsent paste re-issued could end twice its length past the server's clock, which
          // the server refuses for good (release review, round 2).
          const i = place.index.get(idKey(op.id)) as number;
          let origin: Id | null = null;
          for (let j = i - 1; j >= 0 && origin === null; j--) {
            const id = place.sequence[j] as Id;
            const key = idKey(id);
            // An unsent insert not re-issued yet isn't there yet, even if a new id now shares its old one's counter.
            if (place.unsent.has(key)) continue;
            origin = renamed.get(key) ?? (fresh.has(id) ? id : null);
          }
          const length = Array.from(op.text).length;
          for (let c = 0; c < length; c++) {
            const key = idKey({ replica: op.id.replica, counter: op.id.counter + c });
            place.unsent.delete(key);
            renamed.set(key, { replica: op.id.replica, counter: counter + c });
          }
          next = { ...op, id: { replica: op.id.replica, counter }, origin };
          counter += length;
        }
      } else {
        let done = true;
        const kept: { replica: string; counter: number; length: number }[] = [];
        for (const span of op.spans) {
          for (let i = 0; i < span.length; i++) {
            const named = { replica: span.replica, counter: span.counter + i };
            const id = renamed.get(idKey(named)) ?? named;
            if (fresh.isCollected(id)) continue;
            if (!fresh.isTombstone(id)) done = false;
            const last = kept.at(-1);
            if (last?.replica === id.replica && last.counter + last.length === id.counter)
              last.length++;
            else kept.push({ ...id, length: 1 });
          }
        }
        if (done) continue;
        if (kept.length > MAX_SPANS) {
          this.#fail('an unsent delete split into more spans than one delete may carry');
          return;
        }
        next = { type: 'delete', spans: kept };
      }
      try {
        fresh.apply(next);
      } catch (error) {
        if (!(
          error instanceof ConflictError ||
          error instanceof RangeError ||
          error instanceof CollectedError ||
          error instanceof ProtocolError
        )) {
          throw error;
        }
        this.#fail(`an unsent edit doesn't apply to the snapshot: ${error.message}`);
        return;
      }
      outbox.push(next === op ? { op, text } : { op: next, text: encodeOp(next) });
    }
    const before = old.text();
    this.#rga = fresh;
    this.#outbox = outbox;
    if (this.#cursor !== null && renamed.size > 0) {
      // Its own cursor may sit in text re-issued just now; the server would refuse to show ids it never logged.
      const rename = (id: Id | null) => (id === null ? null : (renamed.get(idKey(id)) ?? id));
      this.#cursor = { anchor: rename(this.#cursor.anchor), head: rename(this.#cursor.head) };
    }
    this.#seq = seq;
    this.#resync = false;
    const edit = diffText(before, fresh.text());
    if (edit !== null) {
      const changes: Change[] = [];
      if (edit.deleteCount > 0)
        changes.push({ type: 'delete', index: edit.index, count: edit.deleteCount });
      if (edit.text !== '') changes.push({ type: 'insert', index: edit.index, text: edit.text });
      this.#events.onChanges?.(changes);
    }
    if (this.#seq >= (this.#target as number)) this.#goLive();
    if (this.#remote.size > 0) this.#events.onPresence?.();
    this.#events.onProgress?.();
  }

  #rgaOptions(clock: number): { clock: number; capacity?: number } {
    return this.#capacity === undefined ? { clock } : { clock, capacity: this.#capacity };
  }

  /**
   * Caught up: sends everything in the outbox, then this client's cursor. Nothing of the outbox has gone out on this
   * connection yet (edits made before this wait, and a drop forgets the connection), so it all goes.
   */
  #goLive(): void {
    this.#live = true;
    this.#setStatus('online', '');
    this.#flush(0);
    if (this.#cursor !== null) {
      this.#send(encodeClientMessage({ type: 'presence', cursor: this.#cursor }));
    }
  }

  /** Sends the outbox from `from` on, in batches that fit a message. */
  #flush(from: number): void {
    const texts = this.#outbox.slice(from).map((o) => o.text);
    for (const batch of batchOps(texts)) this.#send(encodeClientOps(batch));
  }

  #send(text: string): void {
    if (this.#socket?.readyState === OPEN) this.#socket.send(text);
  }

  /** Forgets the current connection (its handlers then ignore it) and what it had. */
  #drop(): void {
    const socket = this.#socket;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
    }
    this.#socket = null;
    this.#target = null;
    this.#live = false;
    // A snapshot cut off part way is dropped (it was being built aside), and the next connection sends a whole one.
    this.#snapshot = null;
    // Entries held from this connection come again on the next (its hello asks from the last one applied).
    if (this.#held !== null) this.#held = [];
    if (this.#remote.size > 0) {
      // The server sends the cursors shown again on the next join.
      this.#remote.clear();
      this.#events.onPresence?.();
    }
  }

  #retry(reason: string): void {
    if (this.#status === 'failed' || this.#status === 'stopped') return;
    const { initial, max } = this.#backoff;
    // Full doubling up to the cap, then from half to all of it at random, so that clients dropped together
    // don't all come back at the same moment.
    const delay =
      Math.min(max, initial * 2 ** Math.min(this.#attempt, 30)) * (0.5 + this.#random() / 2);
    this.#attempt++;
    this.#setStatus('offline', `${reason}; retrying in ${Math.round(delay)} ms`);
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#open();
    }, delay);
  }

  #fail(reason: string): void {
    const socket = this.#socket;
    this.#drop();
    clearTimeout(this.#timer);
    this.#setStatus('failed', reason);
    socket?.close(1000, 'failed');
  }

  #setStatus(status: Status, detail: string): void {
    this.#status = status;
    this.#detail = detail;
    this.#events.onStatus?.(status, detail);
  }
}

function sameCursor(a: Cursor | null, b: Cursor | null): boolean {
  if (a === null || b === null) return a === b;
  return sameId(a.anchor, b.anchor) && sameId(a.head, b.head);
}

/** 16 random bytes in base64url: 22 characters. */
export function randomReplica(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type { Change, Cursor, Id };

const idKey = (id: { replica: string; counter: number }) => `${id.counter}@${id.replica}`;

/** The order a server that never collected would give the new replica plus the unsent inserts (placeUnsent). */
interface Placement {
  readonly sequence: readonly Id[];
  /** Each id's index in `sequence`. */
  readonly index: ReadonlyMap<string, number>;
  /** The unsent inserts' element ids (#rebuild takes each out as it re-issues it). */
  readonly unsent: Set<string>;
  /** The highest counter the new replica holds, or has collected of this client's: new ids go above it. */
  readonly above: number;
}

/**
 * Where a server that never collected would put each of `unsent`'s inserts, among `fresh`'s elements: a scratch
 * replica of `fresh`'s state, plus the collected elements the inserts' origins lead back to (from `old`, which never
 * collects: each restored under its own id and origin, its text a placeholder, which ordering doesn't read), plus the
 * inserts under their own ids and origins. RGA's order depends only on which elements exist, and removing collected
 * leaves from the origin tree doesn't reorder the rest, so the scratch replica's sequence is that server's, restricted
 * to these elements. Returns the problem instead if an origin is neither held, collected-and-known, nor unsent.
 */
function placeUnsent(old: Rga, fresh: Rga, unsent: readonly Outgoing[]): Placement | string {
  const scratch = new Rga(fresh.replica);
  const restore = new Map<string, Op>();
  const unsentIds = new Set<string>();
  let above = 0;
  try {
    for (const op of fresh.snapshot()) scratch.apply(op);
    // Its clock started at 0, so it is now the highest counter of the new replica's elements.
    above = scratch.clock;
    for (const span of fresh.collectedSpans()) {
      if (span.replica === fresh.replica) above = Math.max(above, span.counter + span.length - 1);
    }
    for (const { op } of unsent) {
      if (op.type !== 'insert') continue;
      let base = op.origin;
      while (base !== null && !fresh.has(base) && fresh.isCollected(base)) {
        if (restore.has(idKey(base))) break;
        const origin = old.originOf(base);
        if (origin === undefined)
          return `the snapshot collected ${formatId(base)}, which this client never had`;
        restore.set(idKey(base), { type: 'insert', id: base, origin, text: '�' });
        base = origin;
      }
    }
    // In any order: an insert waits for its origin.
    for (const op of restore.values()) scratch.apply(op);
    for (const { op } of unsent) {
      if (op.type !== 'insert') continue;
      scratch.apply(op);
      const length = Array.from(op.text).length;
      for (let c = 0; c < length; c++)
        unsentIds.add(idKey({ replica: op.id.replica, counter: op.id.counter + c }));
    }
  } catch (error) {
    return `an unsent edit can't be placed against the snapshot: ${(error as Error).message}`;
  }
  if (scratch.pending > 0)
    return "an unsent edit's origin is in neither the snapshot nor the outbox";
  const sequence = scratch.sequence();
  return {
    sequence,
    index: new Map(sequence.map((id, i) => [idKey(id), i])),
    unsent: unsentIds,
    above,
  };
}
