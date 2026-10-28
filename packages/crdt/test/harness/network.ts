/**
 * A deterministic network simulator for testing that replicas converge (DESIGN.md "Testing convergence").
 *
 * fast-check generates a schedule: local edits at chosen replicas, deliveries of chosen in-flight messages, and
 * redeliveries of messages already delivered. After the schedule, everything still in flight is delivered in a
 * generated order, and every replica must show the same text. A failing schedule shrinks to a short one, and the
 * error lists its steps.
 *
 * Every message goes to every replica once, its sender included: the sync server echoes each operation back to
 * the client that sent it (DESIGN.md "The sync protocol"), so a replica must cope with its own operations coming
 * back (unless `echo` is off). Each of the network's freedoms can be switched off, which is how the self-test shows that each one is
 * what catches a particular kind of broken CRDT.
 */
import fc from 'fast-check';

/** One copy of the replicated object under test. */
export interface Replica<Op> {
  /** What gets compared across replicas at the end. */
  text(): string;
  /**
   * The whole internal state, written canonically (ids, tombstones). If present it's compared too, after the text:
   * replicas whose texts agree but whose hidden state differs will disagree on a later edit.
   */
  state?(): string;
  /** Applies an operation sent by any replica, possibly this one, possibly again. */
  receive(op: Op): void;
}

export interface Subject<Op, R extends Replica<Op>> {
  readonly name: string;
  create(name: string): R;
  /**
   * Makes a local edit at `replica`, in code points: delete `deleteCount` from `index`, then insert `text` there.
   * Applies it to `replica` and returns the operations to send to everyone.
   */
  edit(replica: R, index: number, deleteCount: number, text: string): Op[];
}

export interface NetworkOptions {
  /** Number of replicas: drawn from this range for each schedule. Default 2 to 4. */
  readonly replicas?: readonly [min: number, max: number];
  /** Deliver in-flight messages in any order. Off: oldest first (a causal order). Default on. */
  readonly reorder?: boolean;
  /** Redeliver messages already delivered. Default on. */
  readonly duplicates?: boolean;
  /** Deliver each message to its sender too, as the sync server does. Default on. */
  readonly echo?: boolean;
  /**
   * Let a replica edit before it has received everything sent so far. Off: every edit waits until the network is
   * empty, so no two edits are concurrent. Default on.
   */
  readonly concurrency?: boolean;
  /**
   * After each local edit, require the replica's text to be exactly the old text with the edit applied (in code
   * points). Default off, since a CRDT can converge and still put text in the wrong place.
   */
  readonly localModel?: boolean;
  /** Steps in a schedule, at most. Default 30. */
  readonly maxSteps?: number;
}

export type Step =
  | {
      readonly kind: 'edit';
      readonly replica: number;
      readonly at: number;
      readonly deleteCount: number;
      readonly text: string;
    }
  | { readonly kind: 'deliver'; readonly pick: number }
  | { readonly kind: 'duplicate'; readonly pick: number };

export interface Schedule {
  readonly replicas: number;
  readonly steps: readonly Step[];
  /** Picks for the final delivery of everything still in flight. */
  readonly flush: readonly number[];
}

/** Small alphabets make concurrent edits at the same spot common; the emoji is two UTF-16 units, one code point. */
const TEXT_UNIT = fc.constantFrom('a', 'b', 'c', '😀');

export function schedules(options: NetworkOptions = {}): fc.Arbitrary<Schedule> {
  const [min, max] = options.replicas ?? [2, 4];
  const edit = fc.record(
    {
      kind: fc.constant('edit' as const),
      replica: fc.nat({ max: max - 1 }),
      at: fc.nat(),
      deleteCount: fc.nat({ max: 3 }),
      text: fc.string({ unit: TEXT_UNIT, maxLength: 3 }),
    },
    { noNullPrototype: true },
  );
  const deliver = fc.record(
    { kind: fc.constant('deliver' as const), pick: fc.nat() },
    { noNullPrototype: true },
  );
  const duplicate = fc.record(
    { kind: fc.constant('duplicate' as const), pick: fc.nat() },
    { noNullPrototype: true },
  );
  // Weighted so that a schedule has several edits and about as many deliveries: with fewer edits concurrency is
  // rare, with fewer deliveries everything is left to the final flush.
  const kinds: fc.WeightedArbitrary<Step>[] = [
    { weight: 2, arbitrary: edit },
    { weight: 2, arbitrary: deliver },
  ];
  if (options.duplicates ?? true) kinds.push({ weight: 1, arbitrary: duplicate });
  return fc.record(
    {
      replicas: fc.integer({ min, max }),
      // fast-check's default size keeps arrays to about 10 items whatever maxLength says; 'medium' uses more of it.
      steps: fc.array(fc.oneof(...kinds), { maxLength: options.maxSteps ?? 30, size: 'medium' }),
      flush: fc.array(fc.nat(), { maxLength: 200 }),
    },
    { noNullPrototype: true },
  );
}

/** Thrown when a schedule breaks the property; the message holds the trace. */
export class ConvergenceError extends Error {
  override name = 'ConvergenceError';
}

interface Message<Op> {
  readonly from: number;
  readonly op: Op;
}

interface Delivery {
  readonly message: number;
  readonly to: number;
}

/** Runs one schedule against a subject. Throws ConvergenceError (with the trace) if the property fails. */
export function run<Op, R extends Replica<Op>>(
  subject: Subject<Op, R>,
  schedule: Schedule,
  options: NetworkOptions = {},
): void {
  const reorder = options.reorder ?? true;
  const concurrency = options.concurrency ?? true;
  const echo = options.echo ?? true;
  const replicas = Array.from({ length: schedule.replicas }, (_, i) => subject.create(`r${i}`));
  const messages: Message<Op>[] = [];
  const inFlight: Delivery[] = [];
  const delivered: Delivery[] = [];
  const trace: string[] = [];

  const fail = (problem: string): never => {
    const texts = replicas.map((r, i) => `  r${i}: ${JSON.stringify(r.text())}`);
    throw new ConvergenceError(
      `${subject.name}: ${problem}\nreplicas now:\n${texts.join('\n')}\nsteps:\n${trace.map((t) => `  ${t}`).join('\n')}`,
    );
  };

  const deliver = (d: Delivery, label: string) => {
    const message = messages[d.message] as Message<Op>;
    trace.push(
      `${label} #${d.message} (from r${message.from}) to r${d.to}: ${JSON.stringify(message.op)}`,
    );
    // Each delivery gets its own copy, as each replica on a real network decodes its own: a replica that kept
    // and changed a received object would otherwise change it for every replica (review 1 found a broken toy
    // that passed that way).
    (replicas[d.to] as R).receive(structuredClone(message.op));
  };

  const deliverAt = (index: number, label: string) => {
    const [d] = inFlight.splice(index, 1) as [Delivery];
    deliver(d, label);
    delivered.push(d);
  };

  const drain = (label: string, picks: readonly number[] = []) => {
    let i = 0;
    while (inFlight.length > 0) {
      deliverAt(reorder ? (picks[i++] ?? 0) % inFlight.length : 0, label);
    }
  };

  for (const step of schedule.steps) {
    switch (step.kind) {
      case 'edit': {
        if (!concurrency) drain('deliver (before an edit)');
        const r = step.replica % schedule.replicas;
        const replica = replicas[r] as R;
        const before = Array.from(replica.text());
        const index = step.at % (before.length + 1);
        const deleteCount = Math.min(step.deleteCount, before.length - index);
        if (deleteCount === 0 && step.text === '') break;
        trace.push(
          `r${r} edits: at ${index} delete ${deleteCount} insert ${JSON.stringify(step.text)}`,
        );
        const ops = subject.edit(replica, index, deleteCount, step.text);
        if (options.localModel ?? false) {
          const expected = [
            ...before.slice(0, index),
            step.text,
            ...before.slice(index + deleteCount),
          ].join('');
          if (replica.text() !== expected) {
            fail(
              `r${r}'s local edit gave ${JSON.stringify(replica.text())}, not ${JSON.stringify(expected)}`,
            );
          }
        }
        for (const op of ops) {
          // A copy of what was sent, so the sender changing its op afterwards changes nothing in flight.
          const message = messages.push({ from: r, op: structuredClone(op) }) - 1;
          for (let to = 0; to < schedule.replicas; to++) {
            if (to !== r || echo) inFlight.push({ message, to });
          }
        }
        break;
      }
      case 'deliver':
        if (inFlight.length > 0) deliverAt(reorder ? step.pick % inFlight.length : 0, 'deliver');
        break;
      case 'duplicate':
        if (delivered.length > 0)
          deliver(delivered[step.pick % delivered.length] as Delivery, 'redeliver');
        break;
    }
  }

  drain('flush', schedule.flush);
  const texts = replicas.map((r) => r.text());
  if (texts.some((t) => t !== texts[0])) fail('replicas diverged');
  const states = replicas.map((r) => r.state?.());
  if (states.some((s) => s !== states[0])) {
    const lines = states.map((s, i) => `  r${i}: ${String(s)}`).join('\n');
    fail(`replicas' states diverged (their texts agree):\n${lines}`);
  }
}

/** The convergence property for a subject, for fc.assert or fc.check. */
export function convergence<Op, R extends Replica<Op>>(
  subject: Subject<Op, R>,
  options: NetworkOptions = {},
): fc.IPropertyWithHooks<[Schedule]> {
  return fc.property(schedules(options), (schedule) => {
    run(subject, schedule, options);
  });
}
