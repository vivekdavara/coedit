// A sync-protocol client for the server's tests: raw messages in, decoded messages out, one at a time.
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import {
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage,
  type ServerMessage,
  type Welcome,
} from '@coedit/crdt';
import type { SyncServer } from '../src/server.ts';

export interface Closed {
  readonly code: number;
  readonly reason: string;
}

export class TestClient {
  readonly ws: WebSocket;
  readonly closed: Promise<Closed>;
  readonly #queue: ServerMessage[] = [];
  readonly #waiters: ((message: ServerMessage) => void)[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString('utf8') });
      });
    });
    ws.on('message', (data, isBinary) => {
      assert.equal(isBinary, false, 'the server sends text messages only');
      const message = decodeServerMessage((data as Buffer).toString('utf8'));
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#queue.push(message);
      else waiter(message);
    });
  }

  /** Opens a connection to the server's sync endpoint; rejects if the handshake fails. */
  static async open(
    server: SyncServer,
    options: { path?: string; origin?: string } = {},
  ): Promise<TestClient> {
    const ws = new WebSocket(
      `ws://${server.host}:${server.port}${options.path ?? '/sync'}`,
      options.origin === undefined ? {} : { origin: options.origin },
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.on('error', () => {});
    return new TestClient(ws);
  }

  /** Opens a connection and joins `doc`; returns the client and the welcome. */
  static async join(
    server: SyncServer,
    doc: string,
    replica: string,
    have = 0,
  ): Promise<[TestClient, Welcome]> {
    const client = await TestClient.open(server);
    client.send({ type: 'hello', protocol: 1, doc, replica, have });
    const welcome = await client.next();
    assert.equal(welcome.type, 'welcome');
    return [client, welcome];
  }

  send(message: ClientMessage | string): void {
    this.ws.send(typeof message === 'string' ? message : encodeClientMessage(message));
  }

  /** The next message, waiting up to `ms` for it. */
  next(ms = 5_000): Promise<ServerMessage> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.#waiters.indexOf(waiter);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(new Error(`no message within ${ms} ms`));
      }, ms);
      const waiter = (message: ServerMessage) => {
        clearTimeout(timer);
        resolve(message);
      };
      this.#waiters.push(waiter);
    });
  }

  /** Messages already received and not yet taken. */
  get queued(): number {
    return this.#queue.length;
  }

  /** Expects an error message with `code`, then the connection closing with `closeCode`. */
  async expectError(code: string, closeCode = 1008): Promise<string> {
    const message = await this.next();
    assert.equal(message.type, 'error', JSON.stringify(message));
    assert.equal(message.code, code, message.message);
    assert.equal((await this.closed).code, closeCode);
    return message.message;
  }

  close(): void {
    this.ws.terminate();
  }
}
