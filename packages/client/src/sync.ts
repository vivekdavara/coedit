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
 *   recognized and not logged twice.
 * - **Errors.** A connection that closes is retried with exponential backoff and jitter. An `error` message other
 *   than `server-error` means retrying would be refused the same way, so the client stops (status `failed`).
 */
import {
  ConflictError,
  ProtocolError,
  Rga,
  batchOps,
  decodeServerMessage,
  encodeClientMessage,
  encodeClientOps,
  encodeOp,
  sameId,
  type Change,
  type Cursor,
  type Id,
  type Op,
  type ServerMessage,
} from '@coedit/crdt';

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
  readonly rga: Rga;
  readonly #url: string;
  readonly #connect: (url: string) => SocketLike;
  readonly #events: SyncEvents;
  readonly #backoff: { readonly initial: number; readonly max: number };
  readonly #random: () => number;

  /** The last log sequence number applied. */
  #seq = 0;
  /** Local operations the server hasn't echoed yet, oldest first. */
  readonly #outbox: Outgoing[] = [];
  /** How many of the outbox's first operations went out on the current connection. */
  #sent = 0;
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

  constructor(options: SyncOptions, events: SyncEvents = {}) {
    this.doc = options.doc;
    this.replica = options.replica ?? randomReplica();
    this.rga = new Rga(
      this.replica,
      options.capacity === undefined ? {} : { capacity: options.capacity },
    );
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
   * Drops the connection as a network failure would, and reconnects after the usual backoff: for tests, and for
   * the editor's "go offline" switch.
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
    const ops = this.rga.edit(index, deleteCount, text);
    const first = this.#outbox.length;
    for (const op of ops) this.#outbox.push({ op, text: encodeOp(op) });
    if (this.#live) this.#flush(first);
  }

  /** This client's selection moved (code points), or null: hidden. Sent to the others when it changes. */
  select(selection: Selection | null): void {
    const cursor =
      selection === null
        ? null
        : { anchor: this.rga.idBefore(selection.anchor), head: this.rga.idBefore(selection.head) };
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
      const anchor = this.rga.indexAfter(cursor.anchor);
      const head = this.rga.indexAfter(cursor.head);
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
          have: this.#seq,
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
        if (this.#seq === message.seq) this.#goLive();
        return;
      }
      case 'ops': {
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
            this.#sent = Math.max(0, this.#sent - 1);
          } else {
            try {
              for (const change of this.rga.apply(op)) changes.push(change);
            } catch (error) {
              if (!(error instanceof ConflictError || error instanceof RangeError)) throw error;
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

  /** Caught up: sends everything in the outbox, then this client's cursor. */
  #goLive(): void {
    this.#live = true;
    this.#setStatus('online', '');
    this.#flush(this.#sent);
    if (this.#cursor !== null) {
      this.#send(encodeClientMessage({ type: 'presence', cursor: this.#cursor }));
    }
  }

  /** Sends the outbox from `from` on, in batches that fit a message. */
  #flush(from: number): void {
    const texts = this.#outbox.slice(from).map((o) => o.text);
    for (const batch of batchOps(texts)) this.#send(encodeClientOps(batch));
    this.#sent = this.#outbox.length;
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
    this.#sent = 0;
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
