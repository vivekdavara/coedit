// Review 1: kills the mutation that drops closeAllConnections(). The first close test
// only leaves an idle keep-alive connection, which Node's own close() already ends.
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { test } from 'node:test';
import { startServer } from '../src/server.ts';

test('close does not wait for a connection with a request in progress', async () => {
  const server = await startServer({ port: 0 });
  const socket = connect(server.port, server.host);
  socket.on('error', () => {});
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write('GET /healthz HTTP/1.1\r\nHost: x\r\n'); // headers not finished
  await new Promise((resolve) => setTimeout(resolve, 50));
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    server.close().then(() => 'closed'),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve('still open after 2 s');
      }, 2_000);
    }),
  ]);
  clearTimeout(timer);
  socket.destroy();
  assert.equal(outcome, 'closed');
});
