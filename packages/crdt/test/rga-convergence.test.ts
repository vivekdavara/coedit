// RGA through the network simulator (DESIGN.md "Testing convergence", day 2): generated schedules of concurrent
// edits, deliveries in any order, redeliveries and echoes, every operation through the real codec. At the end every
// replica's text and whole state (ids, tombstones, waiting operations) must agree, nothing may still be waiting,
// every local edit must have landed exactly where it was made, and every delivery's visible changes must replay.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import { REPLICA_NAMES, run, schedules, type NetworkOptions } from './harness/network.ts';
import { RgaReplica, rgaSubject, wire, type RgaSubjectOptions } from './harness/rga-subject.ts';

const MAX = Number.MAX_SAFE_INTEGER;

/** Every freedom on, the state check compulsory, the real codec, and the local-edit model. */
const FULL: NetworkOptions = { requireState: true, transport: wire, localModel: true };

/** The convergence property, plus: after the final flush no replica holds a waiting operation. */
function converges(subject: RgaSubjectOptions, options: NetworkOptions, numRuns: number): void {
  fc.assert(
    fc.property(schedules(options), (schedule) => {
      const replicas: RgaReplica[] = [];
      run(rgaSubject({ ...subject, created: (r) => replicas.push(r) }), schedule, options);
      for (const r of replicas) assert.equal(r.rga.pending, 0, `${r.rga.replica} still waits`);
    }),
    { numRuns },
  );
}

describe('RGA converges', () => {
  test('with 2 to 5 replicas and every freedom on', () => {
    converges({}, { ...FULL, replicas: [2, 5] }, 1_000);
  });

  test('over long schedules with up to 6 replicas', () => {
    converges({}, { ...FULL, replicas: [2, 6], maxSteps: 80 }, 200);
  });

  test('with delivery in causal order and no duplicates (the server topology)', () => {
    converges({}, { ...FULL, reorder: false, duplicates: false }, 300);
  });

  test('with clocks starting near 2^31', () => {
    converges({ clock: () => 2 ** 31 - 20 }, { ...FULL, replicas: [2, 4] }, 300);
  });

  test('with clocks starting near 2^53 - 1 - 10,000', () => {
    converges({ clock: () => MAX - 10_000 }, { ...FULL, replicas: [2, 4] }, 300);
  });

  test('with clocks starting far apart', () => {
    // m 0, Z near 2^31, b near 2^53, B 5, mm 2^32, a_ just below b.
    const clocks = [0, 2 ** 31 - 3, MAX - 10_000, 5, 2 ** 32, MAX - 10_001];
    const byName = new Map(REPLICA_NAMES.map((name, i) => [name as string, clocks[i] ?? 0]));
    converges({ clock: (name) => byName.get(name) ?? 0 }, { ...FULL, replicas: [2, 6] }, 300);
  });
});

test('the schedules exercise waiting, released and silent deliveries', () => {
  // Without these the convergence tests above could pass on schedules that never reorder anything (review 1 of
  // day 1 found a generator that did that). Counted over 300 seeded schedules; measured at the commit that added
  // this: an operation waited in 183 schedules (61%), a delivery returned several changes in 153 (51%), and 4,316
  // of 7,958 deliveries (54%) changed nothing. The bounds are about three quarters of that.
  const totals = { schedules: 0, waited: 0, multiple: 0, deliveries: 0, silent: 0 };
  fc.assert(
    fc.property(schedules({ replicas: [2, 5] }), (schedule) => {
      const replicas: RgaReplica[] = [];
      run(rgaSubject({ created: (r) => replicas.push(r) }), schedule, FULL);
      totals.schedules++;
      if (replicas.some((r) => r.counts.waiting > 0)) totals.waited++;
      if (replicas.some((r) => r.counts.multiple > 0)) totals.multiple++;
      for (const r of replicas) {
        totals.deliveries += r.counts.deliveries;
        totals.silent += r.counts.silent;
      }
    }),
    { numRuns: 300, seed: 1 },
  );
  assert.ok(
    totals.waited / totals.schedules > 0.45,
    `waited in ${totals.waited} of ${totals.schedules}`,
  );
  assert.ok(totals.multiple / totals.schedules > 0.35, `multiple in ${totals.multiple}`);
  assert.ok(
    totals.silent / totals.deliveries > 0.4,
    `silent ${totals.silent} of ${totals.deliveries}`,
  );
});
