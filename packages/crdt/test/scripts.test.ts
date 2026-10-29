// The measurement scripts whose output the README quotes, run small. harness-stats' counting broke once without any
// test noticing (it reported 0.0 redeliveries after the simulator started copying messages), so their output is
// checked for numbers that can't be right.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const SCRIPT = fileURLToPath(new URL('../scripts/harness_stats.ts', import.meta.url));

test('harness-stats reports sane schedule contents and catches every broken toy', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', SCRIPT, '300', '20'],
    { timeout: 60_000 },
  );
  const contents =
    /(\d+\.\d) edits each, (\d+\.\d) of them concurrent.*?; (\d+\.\d)% of schedules.*?; (\d+\.\d) redeliveries each/.exec(
      stdout,
    );
  assert.ok(contents !== null, stdout);
  const [edits, concurrent, withConcurrent, redeliveries] = contents.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  assert.ok(edits >= 3, `edits ${edits}`);
  assert.ok(concurrent > 0 && concurrent < edits, `concurrent ${concurrent} of ${edits}`);
  assert.ok(withConcurrent > 30 && withConcurrent < 100, `${withConcurrent}%`);
  assert.ok(redeliveries > 0.5, `redeliveries ${redeliveries}`);
  const caught = [...stdout.matchAll(/caught on (\d+) of (\d+) seeds/g)];
  assert.equal(caught.length, 5, stdout);
  for (const [, n, of] of caught) assert.equal(n, of, stdout);
});

const run = async (script: string, args: string[], flags: string[] = []) =>
  (
    await promisify(execFile)(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        ...flags,
        fileURLToPath(new URL(script, import.meta.url)),
        ...args,
      ],
      { timeout: 60_000 },
    )
  ).stdout;

test('deep-convergence runs every convergence case and reports how many schedules ran', async () => {
  // The count comes from fast-check's own report (review 2: a script that ran 1 schedule still printed "20").
  const stdout = await run('../scripts/deep_convergence.ts', ['20']);
  const passed = [...stdout.matchAll(/: 20 schedules pass, \d+\.\d s$/gm)];
  assert.equal(passed.length, 6, stdout);
  assert.match(stdout, /^6 cases pass, \d+\.\d s$/m);
});

test('worst-delete reports the ids the replica recorded, the time, and a second delete refused', async () => {
  // Review 2: the id count used to be computed from the arguments, so a script that applied one span, or
  // overlapping spans, still printed the full count.
  const stdout = await run('../scripts/worst_delete.ts', ['3', 'twice', '50000'], ['--expose-gc']);
  const first =
    /^accepted: 30000 ids deleted ahead from a (\d+)-byte message: (\d+\.\d) ms, heap \+(\d+) MiB, pending 1$/m.exec(
      stdout,
    );
  assert.ok(first !== null, stdout);
  const [bytes, ms, mib] = [Number(first[1]), Number(first[2]), Number(first[3])];
  assert.ok(bytes > 150 && bytes < 250, `${bytes} bytes for 3 spans`);
  assert.ok(ms > 0, stdout);
  // 30,000 ids ahead take a few MiB; 0 would mean the heap wasn't measured in MiB (review 3).
  assert.ok(mib >= 1, stdout);
  assert.match(
    stdout,
    /^a second one: refused \(RangeError\) in \d+\.\d ms; then 30000 ids deleted ahead, pending 1$/m,
  );
});
