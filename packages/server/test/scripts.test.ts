// The server's measurement script, run small: its output must describe what it measured (counts that add up).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const SCRIPT = fileURLToPath(new URL('../scripts/storage.ts', import.meta.url));

test('storage measures appends three ways, then loading from the log and from a snapshot', async () => {
  const { stdout: out } = await promisify(execFile)(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', SCRIPT, '50', '600'],
    { timeout: 60_000 },
  );
  assert.match(out, /^appends: 50 messages of one insert each$/m);
  const ways = [
    ...out.matchAll(/^ {2}(.+): ([\d,]+) messages\/s; submit p50 ([\d.]+) ms, p99 ([\d.]+) ms/gm),
  ];
  assert.deepEqual(
    ways.map((m) => m[1]),
    ['in memory only', 'store, no fsync', 'store, fsync each message'],
  );
  for (const m of ways) assert.ok(Number(m[3]) <= Number(m[4]), out);
  const log = /loading a document of 600 log entries \(([\d,]+) bytes of log\)/.exec(out);
  assert.ok(log !== null && Number(log[1]?.replaceAll(',', '')) > 600 * 40, out);
  // 600 entries, every sixth a backspace: 500 characters typed, 100 deleted.
  assert.match(out, /from the log alone: [\d,]+ ms \(400 visible characters\)/);
  assert.match(out, /writing a snapshot of it .*: [\d,]+ ms, [\d,]+ bytes/);
  // Two more characters, and only the entries since the previous snapshot read back.
  assert.match(
    out,
    /from the snapshot: [\d,]+ ms \(402 visible characters; it also reads the 1 entries kept/,
  );
});
