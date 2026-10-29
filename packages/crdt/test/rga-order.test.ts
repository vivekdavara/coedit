// The order RGA's rule produces, against an independent implementation of what DESIGN.md "Insert" says it is: each
// element a child of its origin, children sorted by id from largest to smallest, the document read in preorder.
// The convergence tests show that replicas agree with each other; this shows that what they agree on is that tree.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import type { Id, InsertOp, Op } from '../src/protocol.ts';
import { Rga } from '../src/rga.ts';
import { wire } from './harness/rga-subject.ts';
import { sessions } from './harness/sessions.ts';

const key = (id: Id | null) => (id === null ? 'HEAD' : `${id.counter}@${id.replica}`);

/** Larger ids first: by counter, then by replica in UTF-16 code units, written out here rather than imported. */
function largerFirst(a: Id, b: Id): number {
  if (a.counter !== b.counter) return b.counter - a.counter;
  for (let i = 0; i < Math.min(a.replica.length, b.replica.length); i++) {
    const d = b.replica.charCodeAt(i) - a.replica.charCodeAt(i);
    if (d !== 0) return d;
  }
  return b.replica.length - a.replica.length;
}

/** Every element's id in the tree's preorder. */
function preorder(inserts: readonly InsertOp[]): string[] {
  const children = new Map<string, Id[]>();
  for (const op of inserts) {
    Array.from(op.text).forEach((_, k) => {
      const id = { replica: op.id.replica, counter: op.id.counter + k };
      const origin = k === 0 ? op.origin : { replica: op.id.replica, counter: id.counter - 1 };
      const list = children.get(key(origin)) ?? [];
      list.push(id);
      children.set(key(origin), list);
    });
  }
  for (const list of children.values()) list.sort(largerFirst);
  const order: string[] = [];
  // An explicit stack: a long run is a chain as deep as it is long.
  const stack = [...(children.get('HEAD') ?? [])].reverse();
  while (stack.length > 0) {
    const id = stack.pop() as Id;
    order.push(key(id));
    stack.push(...[...(children.get(key(id)) ?? [])].reverse());
  }
  return order;
}

/** The ids of a replica's placed elements, in order, read from its state(). */
function sequence(rga: Rga): string[] {
  const placed = rga.state().split(' | ')[0] as string;
  return [...placed.matchAll(/(?:^| )(\d+@[A-Za-z0-9_-]+)/g)].map((m) => m[1] as string);
}

test("a replica's sequence is the origin tree in preorder, children largest first", () => {
  fc.assert(
    fc.property(
      sessions.chain((ops) =>
        fc.tuple(fc.constant(ops), fc.array(fc.nat(), { maxLength: 300, size: 'max' })),
      ),
      ([ops, picks]) => {
        const rga = new Rga('r');
        const left = [...ops];
        for (let i = 0; left.length > 0; i++) {
          rga.apply(wire(left.splice((picks[i] ?? 0) % left.length, 1)[0]));
        }
        const inserts = ops.filter((op): op is InsertOp => op.type === 'insert');
        assert.deepEqual(sequence(rga), preorder(inserts));
      },
    ),
    { numRuns: 1_000 },
  );
});

test('the sequence reader and the tree agree on a hand-made example', () => {
  // HEAD's children: 3@b (larger) then 1@a; 1@a's child 2@a; 3@b's child 4@a.
  const ops: Op[] = [
    { type: 'insert', id: { replica: 'a', counter: 1 }, origin: null, text: 'xy' },
    { type: 'insert', id: { replica: 'b', counter: 3 }, origin: null, text: 'z' },
    {
      type: 'insert',
      id: { replica: 'a', counter: 4 },
      origin: { replica: 'b', counter: 3 },
      text: 'w',
    },
  ];
  const rga = new Rga('r');
  for (const op of ops) rga.apply(op);
  assert.equal(rga.text(), 'zwxy');
  const expected = ['3@b', '4@a', '1@a', '2@a'];
  assert.deepEqual(sequence(rga), expected);
  assert.deepEqual(preorder(ops as InsertOp[]), expected);
});
