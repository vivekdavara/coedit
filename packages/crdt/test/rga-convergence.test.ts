// RGA through the network simulator (DESIGN.md "Testing convergence", day 2): generated schedules of concurrent
// edits, deliveries in any order, redeliveries and echoes, every operation through the real codec. At the end every
// replica's text and whole state (ids, tombstones, waiting operations) must agree, nothing may still be waiting,
// every local edit must have landed exactly where it was made, and every delivery's visible changes must replay.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import { run, schedules } from './harness/network.ts';
import {
  CONVERGENCE_CASES,
  FULL,
  RgaReplica,
  rgaConvergence,
  rgaSubject,
} from './harness/rga-subject.ts';

describe('RGA converges', () => {
  for (const c of CONVERGENCE_CASES) {
    test(c.name, () => {
      fc.assert(rgaConvergence(c.subject, c.network), { numRuns: c.runs });
    });
  }
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
