// Review 1 of day 2 (at 0cbad60): its findings, each of which failed before its fix.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { DeleteOp } from '../src/protocol.ts';
import { Rga } from '../src/rga.ts';

const del = (...spans: [number, string, number][]): DeleteOp => ({
  type: 'delete',
  spans: spans.map(([counter, replica, length]) => ({ replica, counter, length })),
});

// Finding 1 (already fixed in 63e271a when the review reported it): a delete was counted as pending only if it
// named a missing id no earlier delete had named, so the count depended on the order of arrival.
test('three deletes waiting on ids that never arrive count three in either order', () => {
  const d1 = del([5, 'a', 2]);
  const d2 = del([5, 'a', 1]);
  const d3 = del([6, 'a', 1]);
  const x = new Rga('x');
  for (const op of [d1, d2, d3]) x.apply(op);
  const y = new Rga('y');
  for (const op of [d2, d3, d1]) y.apply(op);
  assert.equal(x.state(), y.state());
  assert.equal(x.pending, 3);
  assert.equal(y.pending, 3);
});

test('two concurrent deletes of the same text, the insert not yet here, count the same in either order', () => {
  const a = new Rga('a');
  const b = new Rga('b');
  const c = new Rga('c');
  for (const op of a.edit(0, 0, 'ab')) {
    b.apply(op);
    c.apply(op);
  }
  const [fromB] = b.edit(0, 2, '') as [DeleteOp];
  const [fromC] = c.edit(0, 1, '') as [DeleteOp];
  const x = new Rga('x');
  x.apply(fromB);
  x.apply(fromC);
  const y = new Rga('y');
  y.apply(fromC);
  y.apply(fromB);
  assert.equal(x.state(), y.state());
  assert.equal(x.pending, 2);
  assert.equal(y.pending, 2);
});

// Finding 2: releasing the runs waiting on one element spread the whole list into push(), which overflows the
// stack at about 110,000 runs, after the releasing insert was placed and the runs were taken out of the waiting
// map: they were lost (known, so a resend was a duplicate; never placed; not pending). state() spread the same
// list. With a 100 KB stack the old code overflowed at 20,000 (and not at 5,000), so the test runs there.
test('an element releasing 20,000 waiting runs places them all, even on a small stack', async () => {
  const script = fileURLToPath(new URL('./harness/fanout.ts', import.meta.url));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--stack-size=100', '--disable-warning=ExperimentalWarning', script, '20000'],
    { timeout: 60_000 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    waited: 20_000,
    listed: 20_000,
    threw: null,
    changes: 20_001,
    length: 20_001,
    pending: 0,
  });
});
