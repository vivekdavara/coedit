// The network simulator's self-test: it must pass a correct replicated text, and catch each broken one exactly
// when the network freedom that exposes its flaw is on. If it couldn't, a passing CRDT would prove nothing.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import {
  ConvergenceError,
  convergence,
  run,
  type NetworkOptions,
  type Replica,
  type Subject,
} from './harness/network.ts';
import { assumesCausalDelivery, byIndex, notIdempotent, sortedText } from './harness/toys.ts';

/** Every freedom off: one edit at a time, delivered in order, once. */
const TAME: NetworkOptions = { reorder: false, duplicates: false, echo: false, concurrency: false };

const passes = <Op, R extends Replica<Op>>(subject: Subject<Op, R>, options: NetworkOptions) => {
  fc.assert(convergence(subject, options), { numRuns: 300 });
};

/** Requires the property to fail, and returns the shrunk counterexample's error. */
const fails = <Op, R extends Replica<Op>>(
  subject: Subject<Op, R>,
  options: NetworkOptions,
): ConvergenceError => {
  const details = fc.check(convergence(subject, options), { numRuns: 2_000 });
  assert.ok(
    details.failed,
    `${subject.name} passed ${details.numRuns} schedules with ${JSON.stringify(options)}`,
  );
  const error = details.errorInstance;
  assert.ok(error instanceof ConvergenceError, `not a ConvergenceError: ${String(error)}`);
  return error;
};

describe('a correct replicated text', () => {
  test('converges with every freedom on', () => {
    passes(sortedText, {});
  });

  test('converges with 2 to 6 replicas and long schedules', () => {
    fc.assert(convergence(sortedText, { replicas: [2, 6], maxSteps: 80 }), { numRuns: 200 });
  });
});

describe('a text edited by index', () => {
  test('converges when no two edits are concurrent and delivery is in order', () => {
    passes(byIndex, { ...TAME, duplicates: true, echo: true });
  });

  test('diverges once edits are concurrent', () => {
    const error = fails(byIndex, { ...TAME, concurrency: true });
    assert.match(error.message, /replicas diverged/);
  });

  test('keeps its local edits exactly where they were typed', () => {
    passes(byIndex, { ...TAME, localModel: true });
  });
});

describe('a text that is not idempotent', () => {
  test('converges when each operation arrives once and is not echoed', () => {
    passes(notIdempotent, { ...TAME, reorder: true, concurrency: true });
  });

  test('diverges when operations are redelivered', () => {
    fails(notIdempotent, { ...TAME, reorder: true, concurrency: true, duplicates: true });
  });

  test('diverges when operations are echoed to their sender', () => {
    fails(notIdempotent, { ...TAME, reorder: true, concurrency: true, echo: true });
  });
});

describe('a text that assumes causal delivery', () => {
  test('converges when delivery is in order', () => {
    passes(assumesCausalDelivery, { reorder: false });
  });

  test('diverges when delivery is reordered', () => {
    fails(assumesCausalDelivery, {});
  });
});

describe('the local model check', () => {
  test('fails a text that ignores where text was typed, even with every freedom off', () => {
    const error = fails(sortedText, { ...TAME, localModel: true });
    assert.match(error.message, /local edit gave/);
  });
});

describe('failures', () => {
  test('shrink to a short schedule with a readable trace', () => {
    const error = fails(byIndex, {});
    const steps = error.message.split('\nsteps:\n')[1]?.split('\n') ?? [];
    // Two concurrent edits and the deliveries that expose them.
    assert.ok(steps.length <= 8, error.message);
    assert.match(error.message, /^text by index: replicas diverged\nreplicas now:\n {2}r0: /);
    assert.match(error.message, /r\d edits: at \d+ delete \d+ insert /);
  });

  test('run replays a schedule deterministically', () => {
    const schedule = {
      replicas: 2,
      steps: [
        { kind: 'edit', replica: 0, at: 0, deleteCount: 0, text: 'a' },
        { kind: 'edit', replica: 1, at: 0, deleteCount: 0, text: 'b' },
      ],
      flush: [],
    } as const;
    // r0 has "a", r1 has "b"; by index, each then inserts the other's text at 0: "ba" against "ab".
    assert.throws(() => {
      run(byIndex, schedule, { echo: false });
    }, /replicas diverged\nreplicas now:\n {2}r0: "ba"\n {2}r1: "ab"/);
    run(sortedText, schedule);
  });
});
