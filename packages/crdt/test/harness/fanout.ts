// Review 1 of day 2: N runs waiting on one origin, then the origin. Prints what the release did as JSON.
// Run by review1-rga.test.ts in a child process with a small stack, so a spread of the waiting list overflows
// at a size the test can afford. Usage: node fanout.ts N
import { Rga } from '../../src/rga.ts';

const n = Number(process.argv[2]);
const rga = new Rga('r');
for (let i = 0; i < n; i++) {
  rga.apply({
    type: 'insert',
    id: { replica: `w${i % 1000}`, counter: 2 + Math.floor(i / 1000) },
    origin: { replica: 'q', counter: 1 },
    text: 'x',
  });
}
const waited = rga.pending;
// state() lists every waiting run; it spread them the same way.
const listed = rga.state().split(', ').length;
let threw: string | null = null;
let changes = 0;
try {
  changes = rga.apply({
    type: 'insert',
    id: { replica: 'q', counter: 1 },
    origin: null,
    text: 'Q',
  }).length;
} catch (error) {
  threw = String(error);
}
console.log(
  JSON.stringify({ waited, listed, threw, changes, length: rga.length, pending: rga.pending }),
);
