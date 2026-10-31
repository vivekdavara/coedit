// Review 2 of day 4: a local edit just before a long deleted stretch still costs a step per tombstone.
//
// What's wrong: Rga.edit finds the origin and the targets by walking element by element from the block holding
// visible element index - 1, and stops only at the first visible element at index + deleteCount or later. With
// deleteCount 0 that's the first visible element after the origin, so when the origin is followed by a long run of
// tombstones (the user deleted a large stretch and types where it was, or types at the end after deleting the
// tail), every keystroke walks past all of them, block after block, though each of those blocks has a visible count
// of 0 and could be skipped whole. Measured at 200,000 elements: 2,000 keystrokes in the middle of a live document
// take 12 ms; the same keystrokes just before 200,000 tombstones take 1,864 ms (0.9 ms each, about what the single
// array took: 2,540 ms).
//
// Right behaviour: the walk needs nothing after the origin when deleteCount is 0, and can skip a block with no
// visible elements (or, generally, a block whose visible count doesn't reach the next position it needs), so an
// edit costs about n / B + B steps however many tombstones follow its index (rga.ts's header claim).
// Fixed: the walk skips blocks with nothing visible and stops at the last element it needs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Rga } from '../src/rga.ts';

function time(f: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 3; round++) {
    const start = performance.now();
    f();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

test('keystrokes just before 200,000 tombstones cost about what keystrokes in a live document do', () => {
  const n = 200_000;
  const live = new Rga('a');
  const dead = new Rga('a');
  for (let i = 0; i < n; i += 10_000) {
    live.edit(live.length, 0, 'x'.repeat(10_000));
    dead.edit(dead.length, 0, 'x'.repeat(10_000));
  }
  // All but the first and the last character deleted: index 1 is followed by n - 2 tombstones.
  dead.edit(1, dead.length - 2, '');
  assert.equal(dead.length, 2);

  let at = 1;
  const deadMs = time(() => {
    for (let i = 0; i < 2000; i++) dead.edit(at++, 0, 'k');
  });
  const liveMs = time(() => {
    for (let i = 0; i < 2000; i++) live.edit(n / 2, 0, 'k');
  });
  assert.ok(
    deadMs < 10 * liveMs + 100,
    `2,000 keystrokes before the tombstones took ${deadMs.toFixed(0)} ms, in a live document ${liveMs.toFixed(0)} ms`,
  );
});
