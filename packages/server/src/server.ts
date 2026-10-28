import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROTOCOL_VERSION } from '@coedit/crdt/protocol';

export interface ServerOptions {
  /** The address to listen on. Default 127.0.0.1: the server is for this machine unless told otherwise. */
  host?: string;
  /** The port to listen on; 0 picks a free one (the tests do). Default 8110. */
  port?: number;
}

export interface SyncServer {
  /** The host and port actually bound, e.g. after asking for port 0. */
  readonly host: string;
  readonly port: number;
  /** Stops listening and closes every connection; resolves once the server is closed. */
  close(): Promise<void>;
}

export const DEFAULT_PORT = 8110;
export const DEFAULT_HOST = '127.0.0.1';

/** Starts the server; resolves once it is listening, rejects if it can't bind. */
export async function startServer(options: ServerOptions = {}): Promise<SyncServer> {
  const http = createServer(handleRequest);
  await listen(http, options.host ?? DEFAULT_HOST, options.port ?? DEFAULT_PORT);
  const address = http.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    host: address.address,
    port: address.port,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
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
