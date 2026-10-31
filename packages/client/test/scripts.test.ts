// The client's measurement script runs and prints what it measured (with tiny settings: this checks that it works,
// not the numbers).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const SCRIPT = fileURLToPath(new URL('../scripts/sync_latency.ts', import.meta.url));
const run = promisify(execFile);

test('sync_latency prints both percentile lines for every counted edit', async () => {
  const { stdout } = await run(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', SCRIPT, '2', '260', '1'],
    { timeout: 60_000 },
  );
  assert.match(stdout, /1 writer \+ 2 readers, 260 edits \(200 warm-up\) one every 1 ms/);
  assert.match(
    stdout,
    /^ack {4}p50 [\d.]+ {2}p95 [\d.]+ {2}p99 [\d.]+ {2}max [\d.]+ ms {2}\(n 60\)$/m,
  );
  assert.match(
    stdout,
    /^remote p50 [\d.]+ {2}p95 [\d.]+ {2}p99 [\d.]+ {2}max [\d.]+ ms {2}\(n 120\)$/m,
  );
});

test('sync_latency refuses settings it cannot use', async () => {
  await assert.rejects(
    run(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '1', '100'], {
      timeout: 60_000,
    }),
    (error: { code?: number; stderr?: string }) =>
      error.code === 2 && /usage: sync_latency\.ts/.test(error.stderr ?? ''),
  );
});
