// The simulator's mechanics, one by one, on hand-written schedules. The self-test can't pin these: each broken
// toy is caught by more than one of them, so review 1 could weaken any single one (deliveries always oldest
// first, the flush ignoring its picks, redelivery always of the first message, the final check looking at two
// replicas) with every test still passing.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { replicaName, run, type Schedule, type Step, type Subject } from './harness/network.ts';
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
const R0 = replicaName(0);
const R1 = replicaName(1);
/** Replica 0 types "a" then "b": two messages, in flight to replica 1 (and back to 0 if echo is on). */
const twoSends: Step[] = [edit(0, 0, 'a'), edit(0, 1, 'b')];
const threeSends: Step[] = [...twoSends, edit(0, 2, 'c')];
const schedule = (steps: Step[], flush: number[] = [], replicas = 2): Schedule => ({
  replicas,
  steps,
  flush,
});

describe('the simulator', () => {
  test('a deliver step delivers the in-flight message it picks', () => {
    const { subject, log } = recording();
    run(subject, schedule([...twoSends, { kind: 'deliver', pick: 1 }]), { echo: false });
    assert.deepEqual(log.get(R1), ['b', 'a']);
  });

  test('the flush delivers in the order its picks say', () => {
    const { subject, log } = recording();
    run(subject, schedule(twoSends, [1]), { echo: false });
    assert.deepEqual(log.get(R1), ['b', 'a']);
  });

  test('past its picks, and with reorder off, the flush goes oldest first', () => {
    for (const [flush, options] of [
      [[], {}],
      [[1], { reorder: false }],
    ] as const) {
      const { subject, log } = recording();
      run(subject, schedule(twoSends, [...flush]), { echo: false, ...options });
      assert.deepEqual(log.get(R1), ['a', 'b']);
    }
  });

  test('a redelivery delivers the delivered message it picks', () => {
    // Three delivered, and the middle one picked: not the first, not the last (review 2: a pick of 1 of 2 couldn't
    // tell "the one picked" from "the last").
    const { subject, log } = recording();
    const deliverAll: Step[] = [0, 0, 0].map((pick) => ({ kind: 'deliver', pick }));
    run(subject, schedule([...threeSends, ...deliverAll, { kind: 'duplicate', pick: 1 }]), {
      echo: false,
    });
    assert.deepEqual(log.get(R1), ['a', 'b', 'c', 'b']);
  });

  test('echo sends each message back to its sender once, unless switched off', () => {
    for (const echo of [true, false]) {
      const { subject, log } = recording();
      run(subject, schedule(twoSends), { echo });
      assert.deepEqual(log.get(R0), echo ? ['a', 'b'] : [], `echo ${echo}`);
      assert.deepEqual(log.get(R1), ['a', 'b']);
    }
  });

  test('the final check compares every replica, not just the first two', () => {
    const lastDiffers = (field: 'text' | 'state'): Subject<SortedOp, SortedReplica> => ({
      ...sortedText,
      create(name) {
        const replica = sortedText.create(name);
        if (name === replicaName(3)) {
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

  test('a local edit may change only its own replica, and a delivery only its target', () => {
    // A subject whose replicas share state some way other than through the operations (review 2's broken toy kept
    // elements in a cache common to all replicas) shows it on the first step that changes a bystander.
    const shared = { text: '' };
    const leaky: Subject<SortedOp, SortedReplica> = {
      ...sortedText,
      create(name) {
        const replica = sortedText.create(name);
        if (name === R1) replica.text = () => shared.text;
        return replica;
      },
      edit(replica, index, deleteCount, text) {
        shared.text += text;
        return sortedText.edit(replica, index, deleteCount, text);
      },
    };
    assert.throws(
      () => {
        run(leaky, schedule([edit(0, 0, 'a')]));
      },
      new RegExp(`${R0}'s local edit changed ${R1} too`),
    );
  });

  test('a delivery that changes a bystander is caught too', () => {
    // Here the leak is in receive(), not in edit(): replica 1's text follows what every other replica receives.
    const shared = { text: '' };
    const editing = new Set<string>();
    const leakyReceive: Subject<SortedOp, SortedReplica> = {
      ...sortedText,
      create(name) {
        const replica = sortedText.create(name);
        if (name === R1) replica.text = () => shared.text;
        const receive = replica.receive.bind(replica);
        replica.receive = (op) => {
          if (!editing.has(name) && name !== R1 && op.kind === 'insert') shared.text += op.char;
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
    assert.throws(
      () => {
        run(leakyReceive, schedule([edit(0, 0, 'a')], [], 3), { echo: false });
      },
      new RegExp(`flush to ${replicaName(2)} changed ${R1} too`),
    );
  });

  test('a replica opts in to the state check: all replicas or none, and requireState insists', () => {
    const someWithout: Subject<SortedOp, SortedReplica> = {
      ...sortedText,
      create: (name) =>
        name === R1
          ? Object.assign(sortedText.create(name), { state: undefined })
          : sortedText.create(name),
    };
    assert.throws(() => {
      run(someWithout, schedule([]));
    }, /some replicas have state\(\) and some don't/);
    const noneWith: Subject<SortedOp, SortedReplica> = {
      ...sortedText,
      create: (name) => Object.assign(sortedText.create(name), { state: undefined }),
    };
    run(noneWith, schedule([]));
    assert.throws(() => {
      run(noneWith, schedule([]), { requireState: true });
    }, /requireState is set, but not every replica has state\(\)/);
    run(sortedText, schedule([]), { requireState: true });
  });

  test('the transport is applied once at send and once per delivery', () => {
    let calls = 0;
    const transport = (op: unknown) => {
      calls++;
      return structuredClone(op);
    };
    // Two ops sent, each delivered to both replicas (echo on), then one redelivery: 2 + 4 + 1.
    run(
      sortedText,
      schedule([...twoSends, { kind: 'deliver', pick: 0 }, { kind: 'duplicate', pick: 0 }]),
      {
        transport,
      },
    );
    assert.equal(calls, 7);
  });
});
