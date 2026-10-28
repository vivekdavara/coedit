// What the simulator's default schedules contain. A weak generator fails silently: review 1 could shrink it (always
// 2 replicas, edits only at position 0, one-character inserts, a two-letter alphabet, deletes of 1, 6 steps) with
// every other test still passing, because the broken toys are caught by weak schedules too. These pin the ranges.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import {
  MAX_DELETE,
  MAX_INSERT,
  REPLICA_NAMES,
  TEXT_UNITS,
  run,
  schedules,
  type Step,
  type Subject,
} from './harness/network.ts';
import { sortedText } from './harness/toys.ts';

const SAMPLE = fc.sample(schedules(), { numRuns: 2_000, seed: 7 });
const edits = SAMPLE.flatMap((s) => s.steps).filter(
  (step): step is Extract<Step, { kind: 'edit' }> => step.kind === 'edit',
);
const share = (n: number, of: number) => n / of;

describe('default schedules', () => {
  test('use 2, 3 and 4 replicas, each in at least a fifth of them', () => {
    for (const n of [2, 3, 4]) {
      const fraction = share(SAMPLE.filter((s) => s.replicas === n).length, SAMPLE.length);
      assert.ok(fraction >= 0.2, `${n} replicas in ${(100 * fraction).toFixed(1)}%`);
    }
  });

  test('have long schedules as well as short ones', () => {
    const lengths = SAMPLE.map((s) => s.steps.length);
    assert.ok(Math.max(...lengths) >= 25, `longest ${Math.max(...lengths)}`);
    assert.ok(share(lengths.filter((n) => n >= 15).length, SAMPLE.length) >= 0.2);
  });

  test('insert every unit of the alphabet, in runs of every length up to the maximum', () => {
    const units = new Set(edits.flatMap((e) => Array.from(e.text)));
    assert.deepEqual([...units].sort(), [...TEXT_UNITS].sort());
    const lengths = new Set(edits.map((e) => Array.from(e.text).length));
    for (let n = 0; n <= MAX_INSERT; n++)
      assert.ok(lengths.has(n), `no insert of ${n} code points`);
  });

  test('ask for deletes of every length up to the maximum', () => {
    const counts = new Set(edits.map((e) => e.deleteCount));
    for (let n = 0; n <= MAX_DELETE; n++) assert.ok(counts.has(n), `no delete of ${n}`);
  });

  test('edit at the start, the middle and the end of real text, and delete more than one', () => {
    // Positions only mean something against the text an edit meets, so run the schedules and look.
    const seen = { start: 0, middle: 0, end: 0, multiDelete: 0, editsOnText: 0 };
    type R = ReturnType<typeof sortedText.create>;
    const watching: Subject<Parameters<R['receive']>[0], R> = {
      ...sortedText,
      edit(replica, index, deleteCount, text) {
        const length = Array.from(replica.text()).length;
        if (length >= 3) {
          seen.editsOnText++;
          if (index === 0) seen.start++;
          else if (index === length) seen.end++;
          else seen.middle++;
        }
        if (deleteCount >= 2) seen.multiDelete++;
        return sortedText.edit(replica, index, deleteCount, text);
      },
    };
    for (const schedule of SAMPLE) run(watching, schedule);
    assert.ok(seen.editsOnText >= 1_000, JSON.stringify(seen));
    for (const where of ['start', 'middle', 'end'] as const) {
      assert.ok(share(seen[where], seen.editsOnText) >= 0.1, JSON.stringify(seen));
    }
    assert.ok(seen.multiDelete >= 200, JSON.stringify(seen));
  });

  test('redeliver and reorder', () => {
    const kinds = SAMPLE.flatMap((s) => s.steps.map((step) => step.kind));
    assert.ok(share(kinds.filter((k) => k === 'duplicate').length, kinds.length) >= 0.1);
    assert.ok(share(kinds.filter((k) => k === 'deliver').length, kinds.length) >= 0.25);
    // Deliver picks beyond 0 (0 is always the oldest message).
    const picks = SAMPLE.flatMap((s) => s.steps).filter((step) => step.kind === 'deliver');
    assert.ok(share(picks.filter((p) => p.pick > 0).length, picks.length) >= 0.5);
  });
});

test('replica names order differently by code unit, by locale and by creation', () => {
  const names = [...REPLICA_NAMES];
  const byCodeUnit = [...names].sort().join(' ');
  const byLocale = [...names].sort((a, b) => a.localeCompare(b)).join(' ');
  const byCreation = names.join(' ');
  assert.equal(byCodeUnit, 'B Z a_ b m mm');
  assert.notEqual(byCodeUnit, byLocale);
  assert.notEqual(byCodeUnit, byCreation);
  assert.notEqual(byLocale, byCreation);
});
