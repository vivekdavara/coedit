// The server process killed (SIGKILL, no chance to clean up) while a client is typing, then started again on the same
// data directory: every entry any client saw echoed is still there, so no client is ever ahead of the server, and
// the log after the restart is exactly what was typed, in order, cut off somewhere at or after the last echo.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { Rga } from '@coedit/crdt';
import type { SyncServer } from '../src/server.ts';
import { TestClient } from './client.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

/** Starts main.ts on `data` (with fsync, as `npm start` runs it); resolves with its address once it listens. */
async function start(t: TestContext, data: string) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN], {
    env: { PATH: process.env['PATH'] ?? '', COEDIT_PORT: '0', COEDIT_DATA: data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (match?.[1] !== undefined) resolve(Number(match[1]));
    });
    child.once('exit', (code) => {
      reject(new Error(`exited ${code} before listening: ${out}`));
    });
  });
  const server = { host: '127.0.0.1', port } as SyncServer;
  return { child, server };
}

test('a SIGKILL loses nothing a client saw echoed', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-crash-'));
  t.after(() => {
    fs.rmSync(data, { recursive: true, force: true });
  });
  const typedText = Array.from({ length: 1000 }, (_, i) =>
    String.fromCodePoint(97 + (i % 26)),
  ).join('');

  for (let round = 0; round < 3; round++) {
    const { child, server } = await start(t, data);
    // The whole log first, read by another client: this round's writer types at the end of it. A fresh replica id
    // each round, so the document goes on where the last round's log stopped.
    const rga = new Rga(`w${round}`);
    const [reader, start0] = await TestClient.join(server, 'crash', `r${round}`);
    for (let at = 0; at < start0.seq;) {
      const m = await reader.next();
      if (m.type !== 'ops') continue;
      for (const op of m.ops) rga.apply(op);
      at = m.from + m.ops.length - 1;
    }
    reader.close();
    assert.equal(rga.text(), typedText.slice(0, start0.seq), `round ${round}: the log is a prefix`);

    // 300 characters, one a message, sent without waiting; the server is killed after 100 echoes.
    const [client, welcome] = await TestClient.join(server, 'crash', `w${round}`, start0.seq);
    for (const c of typedText.slice(welcome.seq, welcome.seq + 300)) {
      client.send({ type: 'ops', ops: rga.edit(rga.length, 0, c) });
    }
    let echoed = welcome.seq;
    while (echoed < welcome.seq + 100) {
      const m = await client.next();
      if (m.type === 'ops') echoed = m.from + m.ops.length - 1;
    }
    child.kill('SIGKILL');
    await once(child, 'exit');
    client.close();

    const again = await start(t, data);
    const [check, after] = await TestClient.join(again.server, 'crash', `c${round}`, echoed);
    assert.ok(
      after.seq >= echoed,
      `round ${round}: the log ends at ${after.seq}, before the echo of ${echoed}`,
    );
    check.close();
    again.child.kill('SIGKILL');
    await once(again.child, 'exit');
  }
});
