import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  decodeClientMessage,
  encodeServerMessage,
  type ErrorCode,
} from '@coedit/crdt/protocol';
import { DocumentHub, truncate, type Member } from './hub.ts';

export interface ServerOptions {
  /**
   * The address to listen on. Default 127.0.0.1: the server is for this machine unless told otherwise. An empty
   * string is refused (Node would read it as every interface).
   */
  host?: string;
  /** The port to listen on; 0 picks a free one (the tests do). Default 8110. */
  port?: number;
  /**
   * The web origins whose pages may open a sync connection (DEFAULT_ORIGINS: the client's dev server). A browser
   * sends its page's origin with every WebSocket handshake and lets any page connect anywhere, so without this
   * check any site open in the same browser could read and edit every document. A handshake without an Origin
   * header (not a browser: the tests, a script) is let through.
   */
  origins?: readonly string[];
  /** How long a new connection has to send `hello` (default 10 s). */
  helloTimeoutMs?: number;
  /**
   * The most bytes queued for one client that isn't reading (default 16 MiB). Past it the server drops the
   * connection rather than hold more; the client reconnects and catches up from the log.
   */
  maxBufferedBytes?: number;
  /**
   * How often the server pings each connection (default 30 s). One that hasn't answered the previous ping by the
   * next is dropped: a laptop whose lid closed, or a network that went away, sends no close, and until TCP gives up
   * (which can take hours) its cursor would stay on everyone's screen.
   */
  heartbeatMs?: number;
  /** Each document replica's capacity (Rga's; default its maximum). Tests set it small. */
  capacity?: number;
}

export interface SyncServer {
  /** The host and port actually bound, e.g. after asking for port 0. */
  readonly host: string;
  readonly port: number;
  /** Open sync connections. */
  readonly connections: number;
  /** A document's log length, text and replica state (Rga.state), or undefined if no one has joined it. */
  inspect(doc: string): { seq: number; text: string; state: string } | undefined;
  /** Stops listening and closes every connection; resolves once the server is closed. */
  close(): Promise<void>;
}

export const DEFAULT_PORT = 8110;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_ORIGINS: readonly string[] = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
/** The path of the sync WebSocket. */
export const SYNC_PATH = '/sync';
/** A close code for a connection replaced by a newer one of the same replica (4000-4999 are the application's). */
export const CLOSE_REPLACED = 4001;

/** Starts the server; resolves once it is listening, rejects if it can't bind. */
export async function startServer(options: ServerOptions = {}): Promise<SyncServer> {
  const host = options.host ?? DEFAULT_HOST;
  // listen(port, '') binds every interface; an empty setting must not mean that.
  if (host === '') throw new Error('the host must not be empty');
  const http = createServer(handleRequest);
  const sync = new Sync(options);
  http.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    sync.upgrade(request, socket, head);
  });
  await listen(http, host, options.port ?? DEFAULT_PORT);
  const address = http.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    host: address.address,
    port: address.port,
    get connections() {
      return sync.connections;
    },
    inspect(doc) {
      return sync.inspect(doc);
    },
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        sync.close();
        http.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        // close() waits for open connections to end on their own; a keep-alive client could hold it forever.
        http.closeAllConnections();
      });
      return closing;
    },
  };
}

/** The sync endpoint: WebSocket handshakes on SYNC_PATH, one session per connection, one hub per document. */
class Sync {
  readonly #wss: WebSocketServer;
  readonly #hubs = new Map<string, DocumentHub>();
  readonly #origins: ReadonlySet<string>;
  readonly #helloTimeoutMs: number;
  readonly #maxBufferedBytes: number;
  readonly #capacity: number | undefined;
  /** Connections that answered the last ping (or are newer than it). */
  readonly #alive = new WeakSet<WebSocket>();
  readonly #heartbeat: ReturnType<typeof setInterval>;

  constructor(options: ServerOptions) {
    // ws closes a connection that sends a message over maxPayload with code 1009 (message too big), before
    // reading the rest of it.
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
    this.#origins = new Set(options.origins ?? DEFAULT_ORIGINS);
    this.#helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
    this.#maxBufferedBytes = options.maxBufferedBytes ?? 16 * MAX_MESSAGE_BYTES;
    this.#capacity = options.capacity;
    this.#heartbeat = setInterval(() => {
      for (const ws of this.#wss.clients) {
        if (!this.#alive.has(ws)) {
          ws.terminate();
          continue;
        }
        this.#alive.delete(ws);
        ws.ping();
      }
    }, options.heartbeatMs ?? 30_000);
    // The heartbeat alone mustn't keep the process running.
    this.#heartbeat.unref();
  }

  upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const path = (request.url ?? '').split('?', 1)[0];
    const origin = request.headers.origin;
    if (path !== SYNC_PATH) {
      refuseUpgrade(socket, 404, 'Not Found');
    } else if (origin !== undefined && !this.#origins.has(origin)) {
      refuseUpgrade(socket, 403, 'Forbidden');
    } else {
      this.#wss.handleUpgrade(request, socket, head, (ws) => {
        this.#session(ws);
      });
    }
  }

  get connections(): number {
    return this.#wss.clients.size;
  }

  inspect(doc: string): { seq: number; text: string; state: string } | undefined {
    const hub = this.#hubs.get(doc);
    return hub === undefined ? undefined : { seq: hub.seq, text: hub.text(), state: hub.state() };
  }

  close(): void {
    clearInterval(this.#heartbeat);
    for (const ws of this.#wss.clients) ws.terminate();
    this.#wss.close();
  }

  #hub(doc: string): DocumentHub {
    let hub = this.#hubs.get(doc);
    if (hub === undefined) {
      hub = new DocumentHub(doc, this.#capacity === undefined ? {} : { capacity: this.#capacity });
      this.#hubs.set(doc, hub);
    }
    return hub;
  }

  /**
   * One connection: `hello` first (within the timeout), then `ops` and `presence`. Anything not as the protocol
   * says gets an `error` and the connection is closed.
   */
  #session(ws: WebSocket): void {
    let joined: { hub: DocumentHub; member: Member } | null = null;
    const maxBuffered = this.#maxBufferedBytes;
    const fail = (code: ErrorCode, message: string) => {
      clearTimeout(helloTimer);
      if (ws.readyState === ws.OPEN) {
        ws.send(encodeServerMessage({ type: 'error', code, message: truncate(message) }));
        ws.close(code === 'server-error' ? 1011 : 1008);
      }
    };
    const helloTimer = setTimeout(() => {
      fail('unexpected-message', `no hello within ${this.#helloTimeoutMs} ms`);
    }, this.#helloTimeoutMs);
    this.#alive.add(ws);
    ws.on('pong', () => {
      this.#alive.add(ws);
    });
    // An 'error' event is followed by 'close'; without a listener it would be thrown.
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (joined !== null) joined.hub.leave(joined.member);
      joined = null;
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (ws.readyState !== ws.OPEN) return;
      try {
        if (isBinary) {
          fail('malformed', 'binary messages are not part of the protocol');
          return;
        }
        let message;
        try {
          message = decodeClientMessage(rawText(data));
        } catch (error) {
          if (error instanceof ProtocolError) {
            fail('malformed', error.message);
            return;
          }
          throw error;
        }
        if (message.type === 'hello') {
          if (joined !== null) {
            fail('unexpected-message', 'hello on a connection that has already joined');
            return;
          }
          if (message.protocol !== PROTOCOL_VERSION) {
            fail(
              'unsupported-protocol',
              `this server speaks protocol ${PROTOCOL_VERSION}, not ${message.protocol}`,
            );
            return;
          }
          clearTimeout(helloTimer);
          const hub = this.#hub(message.doc);
          const member: Member = {
            replica: message.replica,
            send(text) {
              if (ws.readyState !== ws.OPEN) return;
              ws.send(text);
              // A client that stops reading: drop it rather than queue without bound. It reconnects and catches
              // up from the log.
              if (ws.bufferedAmount > maxBuffered) ws.terminate();
            },
            replace() {
              joined = null;
              ws.close(CLOSE_REPLACED, 'replaced by a newer connection');
            },
          };
          const refusal = hub.join(member, message.have);
          if (refusal !== null) {
            fail(refusal.code, refusal.message);
            return;
          }
          joined = { hub, member };
          return;
        }
        if (joined === null) {
          fail('unexpected-message', `${message.type} before hello`);
          return;
        }
        if (message.type === 'ops') {
          const refusal = joined.hub.submit(joined.member, message.ops);
          if (refusal !== null) fail(refusal.code, refusal.message);
        } else {
          joined.hub.presence(joined.member, message.cursor);
        }
      } catch (error) {
        console.error('coedit sync: unexpected error', error);
        fail('server-error', 'the server failed to handle that message');
      }
    });
  }
}

/** A text message's data as a string (ws has checked it is UTF-8). */
function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/** Answers a handshake the server won't take with a plain HTTP status, and ends the socket. */
function refuseUpgrade(socket: Socket, status: number, reason: string): void {
  // Node's HTTP server takes its own 'error' listener off the socket before it emits 'upgrade'. Without one, a
  // client that resets the connection while the answer is written (EPIPE, ECONNRESET) makes the socket emit an
  // error nothing handles, and Node throws it: the whole server exits (review of day 3).
  socket.on('error', () => {
    socket.destroy();
  });
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function listen(http: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    http.once('error', onError);
    http.listen(port, host, () => {
      http.off('error', onError);
      resolve();
    });
  });
}

function handleRequest(request: IncomingMessage, response: ServerResponse): void {
  const path = (request.url ?? '').split('?', 1)[0];
  if (path === '/healthz') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
      return;
    }
    sendJson(response, 200, { status: 'ok', protocol: PROTOCOL_VERSION });
    return;
  }
  sendJson(response, 404, { error: 'not found' });
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  });
  // HEAD gets the headers (including the length GET would send) and no body.
  response.end(response.req.method === 'HEAD' ? undefined : text);
}
