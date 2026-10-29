// The RGA convergence properties at many more schedules than the test suite runs (20,000 each by default).
// Run: npm run deep-convergence -w @coedit/crdt -- [schedules per case]
import fc from 'fast-check';
import { CONVERGENCE_CASES, rgaConvergence } from '../test/harness/rga-subject.ts';

const n = Number(process.argv[2] ?? 20_000);
const total = performance.now();
for (const c of CONVERGENCE_CASES) {
  const start = performance.now();
  fc.assert(rgaConvergence(c.subject, c.network), { numRuns: n });
  console.log(
    `${c.name}: ${n} schedules pass, ${((performance.now() - start) / 1000).toFixed(1)} s`,
  );
}
console.log(
  `${CONVERGENCE_CASES.length} cases pass, ${((performance.now() - total) / 1000).toFixed(1)} s`,
);
