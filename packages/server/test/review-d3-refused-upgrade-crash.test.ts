// Review 3 of day 3: a handshake the server refuses (wrong path, or an Origin not allowed) can crash the process.
//
// What is wrong: Node's HTTP server takes its own 'error' listener off the socket before it emits 'upgrade', and
// refuseUpgrade (server.ts, `socket.end(\`HTTP/1.1 ${status} ...\`)`) writes the 404/403 answer without adding one.
// A peer that resets the connection right after sending its handshake makes that write fail (EPIPE or ECONNRESET),
// the socket emits 'error' with no listener, and Node throws it: the server process exits. Anyone who can reach the
// port can do it with one TCP connection; a browser page on any site can at least send the handshake (a WebSocket
// to the server from a page whose Origin isn't allowed), so the 403 path is reachable from the web too. (ws's own
// handleUpgrade adds a listener, so only the server's own refusals have this hole.)
//
// Right behaviour: nothing a client sends crashes the server (server.ts #session's contract, DESIGN.md "The sync
// protocol"); refuseUpgrade should listen for 'error' on the socket (and destroy it) before writing.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

for (const [what, path, origin] of [
  ['a wrong path (404)', '/nope', undefined],
  ['an Origin not allowed (403)', '/sync', 'http://evil.example'],
] as const) {
  test(`the server survives handshakes refused for ${what} and reset at once`, async (t) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN], {
      env: { PATH: process.env['PATH'] ?? '', COEDIT_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
    const deadline = Date.now() + 10_000;
    let port = 0;
    while (port === 0) {
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (match !== null) port = Number(match[1]);
      else if (Date.now() > deadline || child.exitCode !== null)
        assert.fail(`no listening line: ${err}`);
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }

    for (let i = 0; i < 50 && child.exitCode === null; i++) {
      await new Promise<void>((resolve) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.write(
            `GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
              (origin === undefined ? '' : `Origin: ${origin}\r\n`) +
              '\r\n',
          );
          setTimeout(() => {
            socket.resetAndDestroy();
            resolve();
          }, i % 5);
        });
        socket.on('error', () => {
          resolve();
        });
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      child.exitCode,
      null,
      `the server exited: ${err.split('\n').slice(0, 3).join(' | ')}`,
    );
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
  });
}
