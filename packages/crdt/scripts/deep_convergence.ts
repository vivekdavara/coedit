// The RGA convergence properties at many more schedules than the test suite runs (20,000 each by default). The
// counts printed are fast-check's own, so a run that did fewer schedules says so; a failure exits 1.
// Run: npm run deep-convergence -w @coedit/crdt -- [schedules per case]
import fc from 'fast-check';
import { CONVERGENCE_CASES, rgaConvergence } from '../test/harness/rga-subject.ts';

const n = Number(process.argv[2] ?? 20_000);
const total = performance.now();
for (const c of CONVERGENCE_CASES) {
  const start = performance.now();
  const details = fc.check(rgaConvergence(c.subject, c.network), { numRuns: n });
  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  if (details.failed) {
    console.log(
      `${c.name}: FAILED after ${details.numRuns} schedules (seed ${details.seed}), ${seconds} s`,
    );
    console.log(fc.defaultReportMessage(details));
    process.exit(1);
  }
  console.log(`${c.name}: ${details.numRuns} schedules pass, ${seconds} s`);
}
console.log(
  `${CONVERGENCE_CASES.length} cases pass, ${((performance.now() - total) / 1000).toFixed(1)} s`,
);
