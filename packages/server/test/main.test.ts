// The server's command line, run as a child process the way `npm start` runs it.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { hostPort } from '../src/config.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

interface Run {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exit: Promise<number | null>;
}

/** A new empty directory, removed when the test ends. */
function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * Starts main.ts, with its documents in a new directory unless `env` sets COEDIT_DATA. The child is killed when the
 * test ends, however it ends: a failed assertion before the test's own kill would otherwise leave it listening and
 * the test file waiting on it (review 2 saw both).
 */
function start(t: TestContext, env: Record<string, string>): Run {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN], {
    env: { PATH: process.env['PATH'] ?? '', COEDIT_DATA: tempDir(t), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
  const exit = once(child, 'exit').then(([code]) => code as number | null);
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  return { child, stdout: () => out, stderr: () => err, exit };
}

/** Waits for the "listening" line; fails the test (and kills the child) after 10 s. */
async function listening(run: Run): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const match = /listening on (http:\/\/\S+)/.exec(run.stdout());
    if (match?.[1] !== undefined) return match[1];
    if (Date.now() > deadline || run.child.exitCode !== null) {
      run.child.kill('SIGKILL');
      assert.fail(
        `no "listening" line; stdout ${JSON.stringify(run.stdout())}, stderr ${JSON.stringify(run.stderr())}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('main', () => {
  test('serves /healthz on the port it prints, and exits 0 on SIGINT', async (t) => {
    const run = start(t, { COEDIT_PORT: '0' });
    const url = await listening(run);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${url}/healthz`);
    assert.equal(response.status, 200);
    await response.text();
    run.child.kill('SIGINT');
    assert.equal(await run.exit, 0);
    assert.match(run.stdout(), /SIGINT: closing/);
  });

  test('exits 0 on SIGTERM', async (t) => {
    const run = start(t, { COEDIT_PORT: '0' });
    await listening(run);
    run.child.kill('SIGTERM');
    assert.equal(await run.exit, 0);
  });

  test('prints an IPv6 address in brackets', async (t) => {
    const probe = createServer();
    const ok = await new Promise<boolean>((resolve) => {
      probe.once('error', () => {
        resolve(false);
      });
      probe.listen(0, '::1', () => {
        resolve(true);
      });
    });
    probe.close();
    if (!ok) {
      t.skip('no IPv6 loopback here');
      return;
    }
    const run = start(t, { COEDIT_HOST: '::1', COEDIT_PORT: '0' });
    const url = await listening(run);
    assert.match(url, /^http:\/\/\[::1\]:\d+$/);
    const response = await fetch(`${url}/healthz`);
    assert.equal(response.status, 200);
    await response.text();
    run.child.kill('SIGINT');
    assert.equal(await run.exit, 0);
  });

  test('refuses a bad COEDIT_PORT with exit 2', async (t) => {
    for (const port of ['08110', '65536', 'abc', '']) {
      const run = start(t, { COEDIT_PORT: port });
      assert.equal(await run.exit, 2, port);
      assert.match(run.stderr(), /COEDIT_PORT must be a port number from 0 to 65535/);
    }
  });

  test('refuses a bad COEDIT_ORIGINS with exit 2', async (t) => {
    for (const origins of [
      'http://localhost:5173/',
      'localhost:5173',
      'http://a,ftp://b',
      'http://a,,http://b',
    ]) {
      const run = start(t, { COEDIT_ORIGINS: origins, COEDIT_PORT: '0' });
      assert.equal(await run.exit, 2, origins);
      assert.match(run.stderr(), /COEDIT_ORIGINS must be origins like http:\/\/localhost:5173/);
    }
  });

  test('COEDIT_ORIGINS sets which pages may open a sync connection', async (t) => {
    const run = start(t, {
      COEDIT_ORIGINS: 'http://example.test, http://localhost:4000',
      COEDIT_PORT: '0',
    });
    const url = (await listening(run)).replace('http://', 'ws://');
    const status = (origin: string) =>
      new Promise<number | 'open'>((resolve) => {
        const ws = new WebSocket(`${url}/sync`, { origin });
        ws.once('open', () => {
          ws.terminate();
          resolve('open');
        });
        ws.once('unexpected-response', (_request, response) => {
          resolve(response.statusCode ?? 0);
          ws.terminate();
        });
        ws.once('error', () => {});
      });
    assert.equal(await status('http://example.test'), 'open');
    assert.equal(await status('http://localhost:4000'), 'open');
    assert.equal(await status('http://localhost:5173'), 403);
    run.child.kill('SIGTERM');
    assert.equal(await run.exit, 0);
  });

  test('refuses an empty COEDIT_DATA with exit 2', async (t) => {
    const run = start(t, { COEDIT_DATA: '', COEDIT_PORT: '0' });
    assert.equal(await run.exit, 2);
    assert.match(run.stderr(), /COEDIT_DATA must not be empty/);
  });

  test('says where it keeps documents, before the "listening" line', async (t) => {
    const data = tempDir(t);
    const run = start(t, { COEDIT_DATA: data, COEDIT_PORT: '0' });
    await listening(run);
    const out = run.stdout();
    const kept = out.indexOf(`keeps documents in ${data}\n`);
    assert.ok(kept >= 0 && kept < out.indexOf('listening on'), out);
  });

  test('refuses an empty COEDIT_HOST, which Node would read as every interface', async (t) => {
    const run = start(t, { COEDIT_HOST: '', COEDIT_PORT: '0' });
    assert.equal(await run.exit, 2);
    assert.match(run.stderr(), /COEDIT_HOST must not be empty/);
  });

  test("brackets an IPv6 host in the can't-listen message too", async (t) => {
    // Review 2: the message used the raw host, "::1:port", and the bind-error test above was IPv4 only.
    const blocker = createServer();
    const ok = await new Promise<boolean>((resolve) => {
      blocker.once('error', () => {
        resolve(false);
      });
      blocker.listen(0, '::1', () => {
        resolve(true);
      });
    });
    if (!ok) {
      t.skip('no IPv6 loopback here');
      return;
    }
    const address = blocker.address();
    assert.ok(address !== null && typeof address === 'object');
    try {
      const run = start(t, { COEDIT_HOST: '::1', COEDIT_PORT: String(address.port) });
      assert.equal(await run.exit, 1);
      assert.match(run.stderr(), new RegExp(`^can't listen on \\[::1\\]:${address.port}: `));
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  test("says why when it can't listen, with exit 1 and no stack trace", async (t) => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    assert.ok(address !== null && typeof address === 'object');
    try {
      const run = start(t, { COEDIT_PORT: String(address.port) });
      assert.equal(await run.exit, 1);
      assert.match(
        run.stderr(),
        new RegExp(`^can't listen on 127\\.0\\.0\\.1:${address.port}: .*EADDRINUSE`),
      );
      assert.doesNotMatch(run.stderr(), /\n\s+at /);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});

describe('hostPort', () => {
  test('brackets IPv6 addresses only', () => {
    assert.equal(hostPort('127.0.0.1', 8110), '127.0.0.1:8110');
    assert.equal(hostPort('localhost', 1), 'localhost:1');
    assert.equal(hostPort('::1', 8110), '[::1]:8110');
    assert.equal(hostPort('fe80::1%lo0', 80), '[fe80::1%lo0]:80');
  });
});
