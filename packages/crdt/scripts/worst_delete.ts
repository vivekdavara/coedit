// The largest delete the wire format allows, 1,000 spans of 10,000 ids, applied to a replica that holds none of
// them: each id is recorded as deleted ahead of its insert. With `twice`, a second such delete (other ids) follows,
// which passes the replica's capacity and must be refused. README "Limitations (day 2)" quotes it.
// Run: npm run worst-delete -w @coedit/crdt -- [spans] [twice] [capacity]
import { MAX_SPAN_LENGTH, MAX_SPANS, encodeClientMessage, type DeleteOp } from '../src/protocol.ts';
import { MAX_CAPACITY, Rga } from '../src/rga.ts';

const count = Number(process.argv[2] ?? MAX_SPANS);
const twice = process.argv[3] === 'twice';
const capacity = process.argv[4] === undefined ? undefined : Number(process.argv[4]);
const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) throw new Error('run with node --expose-gc');

const worst = (first: number): DeleteOp => ({
  type: 'delete',
  spans: Array.from({ length: count }, (_, i) => ({
    replica: 'a',
    counter: first + i * MAX_SPAN_LENGTH,
    length: MAX_SPAN_LENGTH,
  })),
});

const rga = new Rga('b', capacity === undefined ? {} : { capacity });
const op = worst(1);
const bytes = encodeClientMessage({ type: 'ops', ops: [op] }).length;
gc();
const heap = process.memoryUsage().heapUsed;
const start = performance.now();
rga.apply(op);
const ms = performance.now() - start;
gc();
const mib = (process.memoryUsage().heapUsed - heap) / 2 ** 20;
// Measured, not computed from the arguments: what the replica says it recorded.
const { deletedAhead } = rga.sizes();
console.log(`capacity ${capacity ?? MAX_CAPACITY}`);
console.log(
  `${deletedAhead} ids deleted ahead from a ${bytes}-byte message: ${ms.toFixed(1)} ms, heap +${mib.toFixed(0)} MiB, pending ${rga.pending}`,
);
if (twice) {
  const second = performance.now();
  let outcome = 'accepted';
  try {
    rga.apply(worst(1 + count * MAX_SPAN_LENGTH));
  } catch (error) {
    outcome = `refused (${error instanceof Error ? error.name : 'error'})`;
  }
  const after = rga.sizes();
  console.log(
    `a second one: ${outcome} in ${(performance.now() - second).toFixed(1)} ms; then ${after.deletedAhead} ids deleted ahead, pending ${rga.pending}`,
  );
}
