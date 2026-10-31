// Review 2 of day 3's fixes: d9429a4's refuseUpgrade still leaves the refused socket open.
//
// What is wrong: refuseUpgrade (server.ts) writes the 404/403 with `socket.end(...)` and, since d9429a4, destroys the
// socket only on an 'error'. Node's HTTP server makes its sockets allowHalfOpen, and once it has emitted 'upgrade'
// it no longer manages the socket (no timeouts, and http.closeAllConnections() doesn't reach it). So a peer that
// reads the answer and keeps its end open holds the socket for as long as it likes, and SyncServer.close() (which
// waits for http.close's callback) never resolves while it does: main.ts's SIGTERM/SIGINT handler awaits close(), so
// the process doesn't exit on a signal either. (ws's own refusals, abortHandshake, do
// `socket.once('finish', socket.destroy)` for this reason.)
//
// Right behaviour: a refused handshake's socket is destroyed once its answer is written (for example
// `socket.once('finish', () => socket.destroy())` next to the 'error' listener), so close() resolves promptly.
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { test } from 'node:test';
import { startServer } from '../src/server.ts';

for (const [what, path, origin] of [
  ['a wrong path (404)', '/nope', undefined],
  ['an Origin not allowed (403)', '/sync', 'http://evil.example'],
] as const) {
  test(`close() resolves while a peer refused for ${what} keeps its end open`, async () => {
    const server = await startServer({ port: 0 });
    const socket = connect({ port: server.port, host: server.host, allowHalfOpen: true });
    socket.on('error', () => {});
    try {
      await new Promise<void>((resolve) =>
        socket.once('connect', () => {
          resolve();
        }),
      );
      let answer = '';
      socket.setEncoding('utf8').on('data', (chunk: string) => (answer += chunk));
      // The peer keeps its end open after the server's FIN (it doesn't end or destroy its side).
      socket.on('end', () => {});
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
          (origin === undefined ? '' : `Origin: ${origin}\r\n`) +
          '\r\n',
      );
      const deadline = Date.now() + 5_000;
      while (!answer.includes('\r\n\r\n') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.match(answer, /^HTTP\/1\.1 40[34] /);
      const closed = await Promise.race([
        server.close().then(() => true),
        new Promise<false>((resolve) =>
          setTimeout(() => {
            resolve(false);
          }, 2_000),
        ),
      ]);
      assert.ok(closed, 'close() had not resolved 2 s later: the refused socket is still open');
    } finally {
      socket.destroy();
      await server.close();
    }
  });
}
