// The largest delete the wire format allows, 1,000 spans of 10,000 ids, applied to a replica that holds none of
// them: each id is recorded as deleted ahead of its insert. README "Limitations (day 2)" quotes it.
// Run: npm run worst-delete -w @coedit/crdt -- [spans]
import { MAX_SPAN_LENGTH, MAX_SPANS } from '../src/protocol.ts';
import { Rga } from '../src/rga.ts';

const count = Number(process.argv[2] ?? MAX_SPANS);
const spans = Array.from({ length: count }, (_, i) => ({
  replica: 'a',
  counter: 1 + i * MAX_SPAN_LENGTH,
  length: MAX_SPAN_LENGTH,
}));
const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) throw new Error('run with node --expose-gc');
const rga = new Rga('b');
gc();
const heap = process.memoryUsage().heapUsed;
const start = performance.now();
rga.apply({ type: 'delete', spans });
const ms = performance.now() - start;
gc();
const mib = (process.memoryUsage().heapUsed - heap) / 2 ** 20;
console.log(
  `${count * MAX_SPAN_LENGTH} ids in ${count} spans: ${ms.toFixed(0)} ms, heap +${mib.toFixed(0)} MiB, pending ${rga.pending}`,
);
