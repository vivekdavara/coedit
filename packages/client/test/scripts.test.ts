// The client's measurement scripts run and print what they measured (with tiny settings: this checks that they
// work, not the numbers).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const SCRIPT = fileURLToPath(new URL('../scripts/sync_latency.ts', import.meta.url));
const REBUILD = fileURLToPath(new URL('../scripts/rebuild_cost.ts', import.meta.url));
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

test('rebuild_cost times both cases, and the insert is re-issued only when its origin was collected', async () => {
  const { stdout } = await run(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', REBUILD, '2500', '2'],
    { timeout: 60_000 },
  );
  assert.match(stdout, /^a document of 2,500 characters, 2 runs of each case$/m);
  assert.match(
    stdout,
    /^ {2}no re-issue: 0 collected, 3 snapshot parts, the insert sent as it was$/m,
  );
  assert.match(
    stdout,
    /^ {2}re-issue: 1 collected, 3 snapshot parts, the insert re-issued as 2500@me$/m,
  );
  assert.match(stdout, /^rebuild without re-issuing: [\d.]+, [\d.]+ ms$/m);
  assert.match(stdout, /^rebuild with re-issuing: {4}[\d.]+, [\d.]+ ms$/m);
});
