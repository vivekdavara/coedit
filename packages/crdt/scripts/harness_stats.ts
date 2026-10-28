// How much the network simulator's schedules exercise, and how quickly they catch each broken toy CRDT.
// Run: npm run harness-stats -w @coedit/crdt -- [samples] [seeds]
import fc from 'fast-check';
import {
  convergence,
  run,
  schedules,
  type NetworkOptions,
  type Replica,
  type Subject,
} from '../test/harness/network.ts';
import { assumesCausalDelivery, byIndex, notIdempotent, sortedText } from '../test/harness/toys.ts';

const samples = Number(process.argv[2] ?? 2000);
const seeds = Number(process.argv[3] ?? 200);

// 1. What default schedules contain. A wrapper around the correct toy counts, at each local edit, whether the
// editing replica had yet to receive an operation another replica had already sent: an edit concurrent with it.
const counts = {
  schedules: 0,
  edits: 0,
  concurrent: 0,
  withConcurrent: 0,
  redeliveries: 0,
  chars: 0,
};
for (const schedule of fc.sample(schedules(), { numRuns: samples, seed: 1 })) {
  const sender = new Map<object, string>();
  const received = new Map<string, Set<object>>();
  const here = { concurrent: false };
  let editing = false;
  type R = Replica<object> & { name: string };
  const inner = sortedText as unknown as Subject<object, R>;
  const counting: Subject<object, R> = {
    name: 'counting',
    create(name) {
      const replica = inner.create(name);
      received.set(name, new Set());
      const receive = replica.receive.bind(replica);
      replica.receive = (op) => {
        // The toy applies its own edits through receive(); those aren't deliveries.
        if (editing) {
          receive(op);
          return;
        }
        const seen = received.get(name) as Set<object>;
        if (seen.has(op)) counts.redeliveries++;
        if (sender.get(op) !== name) seen.add(op);
        receive(op);
      };
      return replica;
    },
    edit(replica, index, deleteCount, text) {
      counts.edits++;
      const othersSent = [...sender.values()].filter((s) => s !== replica.name).length;
      if ((received.get(replica.name) as Set<object>).size < othersSent) {
        counts.concurrent++;
        here.concurrent = true;
      }
      editing = true;
      const ops = inner.edit(replica, index, deleteCount, text);
      editing = false;
      for (const op of ops) sender.set(op, replica.name);
      return ops;
    },
  };
  run(counting, schedule);
  counts.schedules++;
  if (here.concurrent) counts.withConcurrent++;
}
console.log(
  `default schedules, ${samples} samples: ${(counts.edits / samples).toFixed(1)} edits each, ` +
    `${(counts.concurrent / samples).toFixed(1)} of them concurrent with an earlier edit; ` +
    `${((100 * counts.withConcurrent) / samples).toFixed(1)}% of schedules have a concurrent edit; ` +
    `${(counts.redeliveries / samples).toFixed(1)} redeliveries each`,
);

// 2. Schedules until each broken toy fails, over many seeds (fc.check stops at the first failure).
const cases: Array<[string, Subject<never, never>, NetworkOptions]> = [
  [
    'by index, concurrency on',
    byIndex as never,
    { reorder: false, duplicates: false, echo: false },
  ],
  ['not idempotent, duplicates on', notIdempotent as never, { duplicates: true, echo: false }],
  ['not idempotent, echo on', notIdempotent as never, { duplicates: false, echo: true }],
  ['assumes causal delivery, reorder on', assumesCausalDelivery as never, {}],
];
for (const [label, subject, options] of cases) {
  const runs: number[] = [];
  for (let seed = 0; seed < seeds; seed++) {
    const details = fc.check(convergence(subject, options), { numRuns: 2000, seed });
    if (details.failed) runs.push(details.numRuns);
  }
  runs.sort((a, b) => a - b);
  const at = (p: number) => runs[Math.min(runs.length - 1, Math.floor(p * runs.length))];
  console.log(
    `${label}: caught on ${runs.length} of ${seeds} seeds; schedules until caught: ` +
      `median ${at(0.5)}, p95 ${at(0.95)}, max ${runs[runs.length - 1]}`,
  );
}
