import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { PROTOCOL_VERSION } from '@coedit/crdt/protocol';
import { parseOrigins, parsePort } from '../src/config.ts';
import { startServer, type SyncServer } from '../src/server.ts';

describe('health endpoint', () => {
  let server: SyncServer;
  let base: string;
  before(async () => {
    server = await startServer({ port: 0 });
    base = `http://${server.host}:${server.port}`;
  });
  after(() => server.close());

  test('GET /healthz reports ok and the protocol version', async () => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { status: 'ok', protocol: PROTOCOL_VERSION });
  });

  test('a query string is ignored', async () => {
    const response = await fetch(`${base}/healthz?x=1`);
    assert.equal(response.status, 200);
    await response.body?.cancel();
  });

  test('HEAD gets the headers and no body', async () => {
    const response = await fetch(`${base}/healthz`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.ok(Number(response.headers.get('content-length')) > 0);
    assert.equal(await response.text(), '');
  });

  test('other methods get 405 with Allow', async () => {
    const response = await fetch(`${base}/healthz`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    await response.body?.cancel();
  });

  test('other paths get 404', async () => {
    for (const path of ['/', '/healthz/', '/HEALTHZ', '/nope']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 404, path);
      await response.body?.cancel();
    }
  });
});

describe('startServer', () => {
  test('binds 127.0.0.1 by default', async () => {
    const server = await startServer({ port: 0 });
    try {
      assert.equal(server.host, '127.0.0.1');
    } finally {
      await server.close();
    }
  });

  test('rejects when the port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    assert.ok(address !== null && typeof address === 'object');
    try {
      await assert.rejects(startServer({ port: address.port }), { code: 'EADDRINUSE' });
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  test('close ends a kept-alive connection and can be called twice', async () => {
    const server = await startServer({ port: 0 });
    const response = await fetch(`http://${server.host}:${server.port}/healthz`);
    await response.text();
    const first = server.close();
    assert.equal(server.close(), first);
    await first;
  });
});

describe('parsePort', () => {
  test('accepts decimal ports 0 to 65535', () => {
    for (const [text, port] of [
      ['0', 0],
      ['1', 1],
      ['8110', 8110],
      ['65535', 65535],
    ] as const) {
      assert.equal(parsePort(text), port);
    }
  });

  test('refuses anything else', () => {
    for (const text of [
      '',
      ' 8110',
      '8110 ',
      '08110',
      '+8110',
      '-1',
      '65536',
      '99999',
      '1e3',
      '0x10',
      '8110.0',
    ]) {
      assert.equal(parsePort(text), undefined, JSON.stringify(text));
    }
  });
});

describe('parseOrigins', () => {
  test('reads origins separated by commas, spaces around them allowed', () => {
    assert.deepEqual(parseOrigins('http://localhost:5173'), ['http://localhost:5173']);
    assert.deepEqual(parseOrigins(' http://a.test , https://b.test:8443 '), [
      'http://a.test',
      'https://b.test:8443',
    ]);
    assert.deepEqual(parseOrigins('http://[::1]:5173'), ['http://[::1]:5173']);
    assert.deepEqual(parseOrigins('http://a:65535,http://b:1'), ['http://a:65535', 'http://b:1']);
  });

  test('an empty setting allows no page', () => {
    assert.deepEqual(parseOrigins(''), []);
    assert.deepEqual(parseOrigins('  '), []);
  });

  test('refuses anything that is not an origin', () => {
    for (const text of [
      'localhost:5173',
      'http://localhost:5173/',
      'http://localhost:5173/x',
      'ftp://a',
      'http://',
      'http://a:0',
      'http://a:05173',
      'http://a:65536',
      'http://a:99999',
      'http://LOCALHOST:5173',
      'HTTP://localhost:5173',
      'http://[::A]:5173',
      'http://a,,http://b',
      'http://a b',
      'null',
      '*',
    ]) {
      assert.equal(parseOrigins(text), undefined, JSON.stringify(text));
    }
  });
});
