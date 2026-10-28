// The simulator's mechanics, one by one, on hand-written schedules. The self-test can't pin these: each broken
// toy is caught by more than one of them, so review 1 could weaken any single one (deliveries always oldest
// first, the flush ignoring its picks, redelivery always of the first message, the final check looking at two
// replicas) with every test still passing.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { run, type Schedule, type Step, type Subject } from './harness/network.ts';
import { sortedText } from './harness/toys.ts';

type SortedReplica = ReturnType<typeof sortedText.create>;
type SortedOp = Parameters<SortedReplica['receive']>[0];
type Insert = Extract<SortedOp, { kind: 'insert' }>;

/** The correct toy, logging the character of each insert every replica receives from the network, in order. */
function recording(): { subject: Subject<SortedOp, SortedReplica>; log: Map<string, string[]> } {
  const log = new Map<string, string[]>();
  const editing = new Set<string>(); // the toy applies its own edits through receive(); those aren't deliveries
  const subject: Subject<SortedOp, SortedReplica> = {
    ...sortedText,
    create(name) {
      const replica = sortedText.create(name);
      const receive = replica.receive.bind(replica);
      log.set(name, []);
      replica.receive = (op) => {
        if (!editing.has(name) && op.kind === 'insert') log.get(name)?.push(op.char);
        receive(op);
      };
      return replica;
    },
    edit(replica, index, deleteCount, text) {
      editing.add(replica.name);
      try {
        return sortedText.edit(replica, index, deleteCount, text);
      } finally {
        editing.delete(replica.name);
      }
    },
  };
  return { subject, log };
}

const edit = (replica: number, at: number, text: string): Step => ({
  kind: 'edit',
  replica,
  at,
  deleteCount: 0,
  text,
});
/** r0 types "a" then "b": two messages, in flight to r1 (and back to r0 if echo is on). */
const twoSends: Step[] = [edit(0, 0, 'a'), edit(0, 1, 'b')];
const schedule = (steps: Step[], flush: number[] = [], replicas = 2): Schedule => ({
  replicas,
  steps,
  flush,
});

describe('the simulator', () => {
  test('a deliver step delivers the in-flight message it picks', () => {
    const { subject, log } = recording();
    run(subject, schedule([...twoSends, { kind: 'deliver', pick: 1 }]), { echo: false });
    assert.deepEqual(log.get('r1'), ['b', 'a']);
  });

  test('the flush delivers in the order its picks say', () => {
    const { subject, log } = recording();
    run(subject, schedule(twoSends, [1]), { echo: false });
    assert.deepEqual(log.get('r1'), ['b', 'a']);
  });

  test('past its picks, and with reorder off, the flush goes oldest first', () => {
    for (const [flush, options] of [
      [[], {}],
      [[1], { reorder: false }],
    ] as const) {
      const { subject, log } = recording();
      run(subject, schedule(twoSends, [...flush]), { echo: false, ...options });
      assert.deepEqual(log.get('r1'), ['a', 'b']);
    }
  });

  test('a redelivery delivers the delivered message it picks', () => {
    const { subject, log } = recording();
    const deliverBoth: Step[] = [
      { kind: 'deliver', pick: 0 },
      { kind: 'deliver', pick: 0 },
    ];
    run(subject, schedule([...twoSends, ...deliverBoth, { kind: 'duplicate', pick: 1 }]), {
      echo: false,
    });
    assert.deepEqual(log.get('r1'), ['a', 'b', 'b']);
  });

  test('echo sends each message back to its sender once, unless switched off', () => {
    for (const echo of [true, false]) {
      const { subject, log } = recording();
      run(subject, schedule(twoSends), { echo });
      assert.deepEqual(log.get('r0'), echo ? ['a', 'b'] : [], `echo ${echo}`);
      assert.deepEqual(log.get('r1'), ['a', 'b']);
    }
  });

  test('the final check compares every replica, not just the first two', () => {
    const lastDiffers = (field: 'text' | 'state'): Subject<SortedOp, SortedReplica> => ({
      ...sortedText,
      create(name) {
        const replica = sortedText.create(name);
        if (name === 'r3') {
          if (field === 'text') replica.text = () => 'x';
          else replica.state = () => 'different';
        }
        return replica;
      },
    });
    assert.throws(() => {
      run(lastDiffers('text'), schedule([], [], 4));
    }, /replicas diverged/);
    assert.throws(() => {
      run(lastDiffers('state'), schedule([], [], 4));
    }, /states diverged/);
  });

  test('a sender changing an operation after sending it changes nothing in flight', () => {
    // On a real network the bytes are gone once sent. This sender scribbles on the inserts it sent last time
    // whenever it edits again; the others must still receive what was sent. (It pins the copy made at send; the
    // per-delivery copy is pinned in review1-harness.test.ts.)
    let lastSent: Insert[] = [];
    const sloppy: Subject<SortedOp, SortedReplica> = {
      ...sortedText,
      edit(replica, index, deleteCount, text) {
        for (const op of lastSent) (op as { char: string }).char = 'X';
        const ops = sortedText.edit(replica, index, deleteCount, text);
        lastSent = ops.filter((op): op is Insert => op.kind === 'insert');
        return ops;
      },
    };
    run(sloppy, schedule(twoSends), { echo: false });
  });
});
