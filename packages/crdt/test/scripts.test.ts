// The measurement script whose output the README quotes, run small. Its counting broke once without any test
// noticing (it reported 0.0 redeliveries after the simulator started copying messages), so its output is checked
// for numbers that can't be right.
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
