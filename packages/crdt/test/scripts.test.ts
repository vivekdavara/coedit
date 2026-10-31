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

test('worst-delete reports a first delete refused for the capacity', async () => {
  // Review 4: only the second delete's refusal was exercised, so the first's label could say anything; the README
  // quotes it ("refused in 69 ms").
  const stdout = await run('../scripts/worst_delete.ts', ['3', 'once', '20000'], ['--expose-gc']);
  assert.match(
    stdout,
    /^refused \(RangeError\): 0 ids deleted ahead from a \d+-byte message: \d+\.\d ms, heap \+\d+ MiB, pending 0$/m,
  );
});

test('editing measures a session it actually ran: every tenth, both readers converged, growth and heap', async () => {
  const out = await run('../scripts/editing.ts', ['500', '7'], ['--expose-gc']);
  const session = /synthetic session: 500 edits \(seed 7\), ([\d,]+) operations/.exec(out);
  assert.ok(session !== null, out);
  const kinds =
    /kinds: type ([\d,]+), backspace ([\d,]+), move ([\d,]+), selection ([\d,]+), paste ([\d,]+), word ([\d,]+)/.exec(
      out,
    );
  assert.ok(kinds !== null, out);
  const counts = kinds.slice(1).map((n) => Number(n.replaceAll(',', '')));
  assert.equal(
    counts.reduce((a, b) => a + b, 0),
    500,
    'every edit is one of the kinds',
  );
  assert.ok(
    counts.every((n) => n > 0),
    out,
  );
  const windows = [
    ...out.matchAll(
      /^ +\d+: ([\d,]+) edits\/s, ending at ([\d,]+) visible \/ ([\d,]+) elements$/gm,
    ),
  ];
  assert.equal(windows.length, 10, out);
  for (const [, rate, visible, elements] of windows) {
    assert.ok(Number(rate?.replaceAll(',', '')) > 0, out);
    assert.ok(Number(visible?.replaceAll(',', '')) <= Number(elements?.replaceAll(',', '')), out);
  }
  assert.match(out, /remote integration: [\d,]+ operations\/s applied .* [\d,]+\/s from JSON text/);
  assert.match(out, /large paste: 100,000 characters \(10 operations\)/);
  const growth = /([\d,]+) visible characters, ([\d,]+) elements, ([\d.]+)% tombstones/.exec(out);
  assert.ok(growth !== null, out);
  // The paste's 100,000 characters were deleted again: they are tombstones now.
  assert.ok(Number(growth[2]?.replaceAll(',', '')) >= 100_000, out);
  assert.ok(Number(growth[3]) > 50 && Number(growth[3]) < 100, out);
  assert.match(out, /snapshot [\d,]+ bytes \([\d.]+ per visible character, \d+ operations\)/);
  const heap =
    /heap: a replica rebuilt from the snapshot takes [\d,-]+ bytes, (-?\d+) per element \(mean of 3 kept at once; same text\)/.exec(
      out,
    );
  assert.ok(heap !== null && Number(heap[1]) > 0, out);
});
