// The document hub without sockets (src/hub.ts): the numbered log, the echo, what it refuses, catch-up and presence.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAX_MESSAGE_BYTES,
  decodeServerMessage,
  utf8Length,
  encodeServerMessage,
  type Cursor,
  type DeleteOp,
  type InsertOp,
  type Op,
  type ServerMessage,
} from '@coedit/crdt';
import { DocumentHub, truncate, type Member } from '../src/hub.ts';

class FakeMember implements Member {
  readonly replica: string;
  readonly texts: string[] = [];
  replaced = false;

  constructor(replica: string) {
    this.replica = replica;
  }

  send(text: string, sent?: () => void): void {
    this.texts.push(text);
    sent?.();
  }

  replace(): void {
    this.replaced = true;
  }

  /** Every message received so far, decoded (each must decode), and forgets them. */
  take(): ServerMessage[] {
    return this.texts.splice(0).map(decodeServerMessage);
  }
}

const insert = (
  counter: number,
  replica: string,
  origin: [number, string] | null,
  text: string,
): InsertOp => ({
  type: 'insert',
  id: { replica, counter },
  origin: origin === null ? null : { counter: origin[0], replica: origin[1] },
  text,
});

const del = (...spans: [counter: number, replica: string, length: number][]): DeleteOp => ({
  type: 'delete',
  spans: spans.map(([counter, replica, length]) => ({ replica, counter, length })),
});

function joined(hub: DocumentHub, replica: string, have = 0): FakeMember {
  const member = new FakeMember(replica);
  assert.equal(hub.join(member, have), null);
  return member;
}

describe('joining', () => {
  test('a new document welcomes with seq 0 and sends nothing else', () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    assert.deepEqual(a.take(), [{ type: 'welcome', protocol: 1, doc: 'd', seq: 0 }]);
    assert.equal(hub.members, 1);
  });

  test('a member gets the entries after its have, numbered', () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    const ops = [insert(1, 'a', null, 'ab'), insert(3, 'a', [2, 'a'], 'c'), del([1, 'a', 1])];
    assert.equal(hub.submit(a, ops), null);
    for (const have of [0, 1, 2, 3]) {
      const b = joined(hub, `b${have}`, have);
      const expected: ServerMessage[] = [{ type: 'welcome', protocol: 1, doc: 'd', seq: 3 }];
      if (have < 3) expected.push({ type: 'ops', from: have + 1, ops: ops.slice(have) });
      assert.deepEqual(b.take(), expected, `have ${have}`);
    }
  });

  test('a long log comes in batches of 1,000, numbered consecutively', () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    const ops: Op[] = [];
    for (let i = 1; i <= 2_500; i++) ops.push(insert(i, 'a', i === 1 ? null : [i - 1, 'a'], 'x'));
    for (let i = 0; i < ops.length; i += 1_000) {
      assert.equal(hub.submit(a, ops.slice(i, i + 1_000)), null);
    }
    const b = joined(hub, 'b', 250);
    const messages = b.take();
    assert.deepEqual(
      messages.map((m) => (m.type === 'ops' ? [m.from, m.ops.length] : m.type)),
      ['welcome', [251, 1_000], [1_251, 1_000], [2_251, 250]],
    );
  });

  test('refuses a have past the end of the log, and does not join', () => {
    const hub = new DocumentHub('d');
    const a = new FakeMember('a');
    const refusal = hub.join(a, 1);
    assert.equal(refusal?.code, 'ahead-of-server');
    assert.match(refusal.message, /applied 1 log entries.*has 0/);
    assert.deepEqual(a.take(), []);
    assert.equal(hub.members, 0);
  });

  test('a second member with the same replica id replaces the first', () => {
    const hub = new DocumentHub('d');
    const old = joined(hub, 'a');
    const other = joined(hub, 'b');
    other.take();
    const renewed = joined(hub, 'a');
    assert.equal(old.replaced, true);
    assert.equal(renewed.replaced, false);
    assert.equal(hub.members, 2);
    assert.deepEqual(other.take(), [{ type: 'presence', replica: 'a', cursor: null }]);
    // The old one gets nothing more.
    old.take();
    assert.equal(hub.submit(renewed, [insert(1, 'a', null, 'x')]), null);
    assert.deepEqual(old.take(), []);
  });
});

/** A member whose writes complete only when the test says so, like a socket draining. */
class SlowMember extends FakeMember {
  readonly pending: (() => void)[] = [];

  override send(text: string, sent?: () => void): void {
    this.texts.push(text);
    if (sent !== undefined) this.pending.push(sent);
  }

  /** Completes the oldest write. */
  drain(): void {
    this.pending.shift()?.();
  }
}

describe('a paced catch-up', () => {
  const chain = (n: number, from = 1): Op[] =>
    Array.from({ length: n }, (_, i) =>
      insert(from + i, 'a', from + i === 1 ? null : [from + i - 1, 'a'], 'x'),
    );

  test('sends one batch at a time, each once the one before is written out', () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    for (let i = 0; i < 3; i++) assert.equal(hub.submit(a, chain(1_000, i * 1_000 + 1)), null);
    const slow = new SlowMember('slow');
    assert.equal(hub.join(slow, 0), null);
    const firsts = () => slow.take().map((m) => (m.type === 'ops' ? m.from : m.type));
    assert.deepEqual(firsts(), ['welcome', 1]);
    slow.drain();
    assert.deepEqual(firsts(), [1_001]);
    slow.drain();
    assert.deepEqual(firsts(), [2_001]);
    slow.drain();
    assert.deepEqual(firsts(), []);
    assert.equal(slow.pending.length, 0);
  });

  test('entries logged meanwhile come from the log, in order, not as live relays; then live ones', () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    assert.equal(hub.submit(a, chain(1_500)), null);
    const slow = new SlowMember('slow');
    hub.join(slow, 0);
    hub.presence(a, { anchor: { replica: 'a', counter: 1 }, head: null });
    assert.equal(hub.submit(a, chain(10, 1_501)), null);
    let messages = slow.take();
    // Neither the ops nor the presence go to it live: it's still catching up.
    assert.deepEqual(
      messages.map((m) => (m.type === 'ops' ? [m.from, m.ops.length] : m.type)),
      ['welcome', [1, 1_000]],
    );
    slow.drain();
    messages = slow.take();
    assert.deepEqual(
      messages.map((m) => (m.type === 'ops' ? [m.from, m.ops.length] : m.type)),
      [[1_001, 510]],
    );
    slow.drain();
    // Caught up: the cursors shown, then live relays.
    assert.deepEqual(slow.take(), [
      {
        type: 'presence',
        replica: 'a',
        cursor: { anchor: { replica: 'a', counter: 1 }, head: null },
      },
    ]);
    assert.equal(hub.submit(a, chain(1, 1_511)), null);
    assert.deepEqual(
      slow.take().map((m) => (m.type === 'ops' ? m.from : m.type)),
      [1_511],
    );
  });

  test('every catch-up message fits 1 MiB, and a member never gets its own cursor', () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    assert.equal(hub.submit(a, [insert(1, 'a', null, 'x'.repeat(1_000))]), null);
    // About 40 KB each: 25 fit a message.
    const big = del(
      ...Array.from({ length: 1_000 }, (_, i): [number, string, number] => [i + 1, 'a', 1]),
    );
    for (let i = 0; i < 60; i++) assert.equal(hub.submit(a, [big]), null);
    const slow = new SlowMember('slow');
    hub.join(slow, 0);
    // Its own cursor, sent during its catch-up, and someone else's.
    hub.presence(slow, { anchor: { replica: 'a', counter: 3 }, head: null });
    hub.presence(a, { anchor: { replica: 'a', counter: 5 }, head: null });
    const sent: string[] = [];
    for (let i = 0; i < 10 && slow.pending.length > 0; i++) {
      sent.push(...slow.texts.splice(0));
      slow.drain();
    }
    sent.push(...slow.texts.splice(0));
    const messages = sent.map(decodeServerMessage);
    // Every entry once, in order, in more than one message.
    let next = 1;
    for (const m of messages) {
      if (m.type !== 'ops') continue;
      assert.equal(m.from, next);
      next += m.ops.length;
    }
    assert.equal(next, 62);
    assert.ok(messages.filter((m) => m.type === 'ops').length >= 3);
    for (const text of sent)
      assert.ok(utf8Length(text) <= MAX_MESSAGE_BYTES, `${utf8Length(text)} bytes`);
    assert.deepEqual(
      messages.filter((m) => m.type === 'presence'),
      [
        {
          type: 'presence',
          replica: 'a',
          cursor: { anchor: { replica: 'a', counter: 5 }, head: null },
        },
      ],
    );
  });

  test('a member that leaves during its catch-up is sent nothing more', () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    assert.equal(hub.submit(a, chain(2_000)), null);
    const slow = new SlowMember('slow');
    hub.join(slow, 0);
    slow.take();
    hub.leave(slow);
    slow.drain();
    assert.deepEqual(slow.take(), []);
    // And one replaced during it: the new member's catch-up runs, the old one's stops.
    const again = new SlowMember('again');
    hub.join(again, 0);
    again.take();
    const renewed = new SlowMember('again');
    hub.join(renewed, 0);
    assert.equal(again.replaced, true);
    again.drain();
    assert.deepEqual(again.take(), []);
    assert.deepEqual(
      renewed.take().map((m) => (m.type === 'ops' ? m.from : m.type)),
      ['welcome', 1],
    );
  });
});

describe('operations', () => {
  test('each accepted operation is numbered and sent to every member, the sender included', () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    const b = joined(hub, 'b');
    a.take();
    b.take();
    const ops = [insert(1, 'a', null, 'hi'), del([2, 'a', 1])];
    assert.equal(hub.submit(a, ops), null);
    const expected = [{ type: 'ops', from: 1, ops }];
    assert.deepEqual(a.take(), expected);
    assert.deepEqual(b.take(), expected);
    assert.equal(hub.seq, 2);
    assert.equal(hub.text(), 'h');
    assert.equal(hub.submit(b, [insert(3, 'b', [1, 'a'], '!')]), null);
    assert.deepEqual(a.take(), [{ type: 'ops', from: 3, ops: [insert(3, 'b', [1, 'a'], '!')] }]);
    assert.equal(hub.text(), 'h!');
  });

  test('a resent insert is not logged again, nor echoed; a resent delete is logged again', () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    const first = insert(1, 'a', null, 'ab');
    assert.equal(hub.submit(a, [first, del([1, 'a', 1])]), null);
    a.take();
    assert.equal(hub.submit(a, [first]), null);
    assert.deepEqual(a.take(), [], 'no echo for the resent insert');
    assert.equal(hub.seq, 2);
    // Its sender waits for an echo of each delete, and the server can't tell a resend from a delete of the same
    // ids by someone else, which also needs its echo.
    assert.equal(hub.submit(a, [first, del([1, 'a', 1]), insert(3, 'a', [2, 'a'], 'c')]), null);
    assert.deepEqual(a.take(), [
      { type: 'ops', from: 3, ops: [del([1, 'a', 1]), insert(3, 'a', [2, 'a'], 'c')] },
    ]);
    assert.equal(hub.text(), 'bc');
  });

  test('refuses an insert whose origin it lacks, and keeps the operations before it', () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    a.take();
    const ok = insert(1, 'a', null, 'x');
    const refusal = hub.submit(a, [
      ok,
      insert(5, 'a', [4, 'a'], 'y'),
      insert(6, 'a', [1, 'a'], 'z'),
    ]);
    assert.deepEqual(refusal, {
      code: 'refused-op',
      message: "ops[1] refused: its origin 4@a isn't an element of this document",
    });
    assert.deepEqual(a.take(), [{ type: 'ops', from: 1, ops: [ok] }]);
    assert.equal(hub.seq, 1);
    assert.equal(hub.text(), 'x');
    assert.doesNotMatch(hub.state(), /waiting \S/);
  });

  test('refuses a delete naming an id it lacks, with nothing relayed', () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    assert.equal(hub.submit(a, [insert(1, 'a', null, 'ab')]), null);
    a.take();
    const refusal = hub.submit(a, [del([1, 'a', 3])]);
    assert.equal(refusal?.code, 'refused-op');
    assert.match(refusal.message, /^ops\[0\] refused: it deletes ids that aren't elements/);
    assert.deepEqual(a.take(), []);
    assert.equal(hub.text(), 'ab');
    assert.doesNotMatch(hub.state(), /deleted ahead \S/);
  });

  test('refuses a delete whose spans overlap, in any order; adjacent spans and other replicas are fine', () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    const b = joined(hub, 'b');
    assert.equal(hub.submit(a, [insert(1, 'a', null, 'abcdef')]), null);
    assert.equal(hub.submit(b, [insert(7, 'b', [6, 'a'], 'xyz')]), null);
    for (const spans of [
      [
        [1, 'a', 2],
        [1, 'a', 2],
      ],
      [
        [1, 'a', 3],
        [3, 'a', 1],
      ],
      [
        [4, 'a', 2],
        [1, 'a', 4],
      ],
      [
        [7, 'b', 1],
        [1, 'a', 1],
        [8, 'b', 2],
        [8, 'b', 1],
      ],
    ] as [number, string, number][][]) {
      const refusal = hub.submit(a, [del(...spans)]);
      assert.deepEqual(
        refusal,
        { code: 'refused-op', message: 'ops[0] refused: its spans overlap' },
        JSON.stringify(spans),
      );
    }
    assert.equal(hub.text(), 'abcdefxyz');
    assert.equal(hub.submit(a, [del([3, 'a', 2], [1, 'a', 2], [7, 'b', 1], [8, 'b', 1])]), null);
    assert.equal(hub.text(), 'efz');
  });

  test("refuses an insert under another replica's id; a delete may name anyone's", () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    const b = joined(hub, 'b');
    assert.equal(hub.submit(b, [insert(1, 'b', null, 'xy')]), null);
    // a taking b's next id: b's next edit would then be refused as a conflict.
    assert.deepEqual(hub.submit(a, [insert(3, 'b', [2, 'b'], 'q')]), {
      code: 'refused-op',
      message: 'ops[0] refused: it inserts under replica b, but this connection is a',
    });
    assert.equal(hub.submit(b, [insert(3, 'b', [2, 'b'], 'z')]), null);
    assert.equal(hub.submit(a, [del([1, 'b', 1])]), null);
    assert.equal(hub.text(), 'yz');
  });

  test("refuses a message whose deletes name more ids than the document holds; an honest outbox doesn't", () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    assert.equal(hub.submit(a, [insert(1, 'a', null, 'abcd')]), null);
    // Each delete is fine alone; together they name 6 ids of a 4-element document.
    const refusal = hub.submit(a, [del([1, 'a', 2]), del([3, 'a', 2]), del([1, 'a', 2])]);
    assert.deepEqual(refusal, {
      code: 'refused-op',
      message:
        "ops[2] refused: this message's deletes name 6 ids, more than the 4 elements of this document",
    });
    // The two before it were applied and logged.
    assert.equal(hub.text(), '');
    assert.equal(hub.seq, 3);
    // Inserts earlier in the same message count: what a client typed and deleted between two sends.
    assert.equal(
      hub.submit(a, [
        insert(5, 'a', [4, 'a'], 'xyz'),
        del([5, 'a', 2]),
        insert(8, 'a', [7, 'a'], '!'),
        del([7, 'a', 2]),
      ]),
      null,
    );
    assert.equal(hub.text(), '');
  });

  test("finds overlaps between spans of one replica with another replica's span between them", () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    // Sorted by counter alone, b's span would sit between a's two and hide the overlap.
    assert.equal(
      hub.submit(a, [del([1, 'a', 2], [1, 'b', 5], [2, 'a', 1])])?.message,
      'ops[0] refused: its spans overlap',
    );
  });

  test('refuses an insert reusing an id with other content', () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    assert.equal(hub.submit(a, [insert(1, 'a', null, 'ab')]), null);
    const refusal = hub.submit(a, [insert(1, 'a', null, 'xy')]);
    assert.equal(refusal?.code, 'refused-op');
    assert.match(refusal.message, /1@a: already known/);
    assert.equal(hub.text(), 'ab');
  });

  test('refuses counters more than its capacity past its clock, and accepts them up to it', () => {
    const hub = new DocumentHub('d', { capacity: 100 });
    const a = joined(hub, 'a');
    // The clock is 0: counters may end at 100.
    const far = hub.submit(a, [insert(99, 'a', null, 'xyz')]);
    assert.equal(far?.code, 'refused-op');
    assert.match(far.message, /end at 101, more than 100 past this document's clock \(0\)/);
    assert.equal(hub.submit(a, [insert(98, 'a', null, 'xyz')]), null);
    // Now the clock is 100.
    assert.equal(hub.submit(a, [insert(200, 'a', [100, 'a'], 'q')]), null);
    assert.equal(hub.submit(a, [insert(301, 'a', [200, 'a'], 'q')])?.code, 'refused-op');
    assert.equal(hub.text(), 'xyzq');
  });

  test('the clock cannot run out: the largest jumps fill the document first', () => {
    // Each insert as far past the clock as allowed, one element each, until the document is full.
    const capacity = 1_000;
    const hub = new DocumentHub('d', { capacity });
    const a = joined(hub, 'a');
    let clock = 0;
    let origin: [number, string] | null = null;
    for (let i = 0; i < capacity; i++) {
      const counter = clock + capacity;
      assert.equal(hub.submit(a, [insert(counter, 'a', origin, 'x')]), null, `insert ${i}`);
      clock = counter;
      origin = [counter, 'a'];
    }
    assert.equal(clock, capacity * capacity);
    const full = hub.submit(a, [insert(clock + 1, 'a', origin, 'x')]);
    assert.equal(full?.code, 'too-large');
    assert.match(full.message, /capacity of 1000/);
  });

  test('a refused operation leaves the server replica as it was', () => {
    const hub = new DocumentHub('d', { capacity: 10 });
    const a = joined(hub, 'a');
    assert.equal(hub.submit(a, [insert(1, 'a', null, 'abc')]), null);
    const before = hub.state();
    for (const bad of [
      insert(4, 'a', [3, 'a'], 'x'.repeat(8)),
      insert(2, 'a', [1, 'a'], 'q'),
      insert(5, 'a', [9, 'a'], 'q'),
      del([1, 'a', 4]),
    ]) {
      assert.notEqual(hub.submit(a, [bad]), null, JSON.stringify(bad));
      assert.equal(hub.state(), before);
      assert.equal(hub.seq, 1);
    }
  });

  test('a member that is not joined cannot submit', () => {
    const hub = new DocumentHub('d');
    assert.throws(
      () => hub.submit(new FakeMember('a'), [insert(1, 'a', null, 'x')]),
      /isn't joined/,
    );
  });
});

describe('presence', () => {
  const cursor = (counter: number): Cursor => ({
    anchor: { replica: 'a', counter },
    head: null,
  });

  test('goes to the other members, not the sender', () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    const b = joined(hub, 'b');
    a.take();
    b.take();
    hub.presence(a, cursor(1));
    assert.deepEqual(a.take(), []);
    assert.deepEqual(b.take(), [{ type: 'presence', replica: 'a', cursor: cursor(1) }]);
  });

  test('a member who joins later gets the cursors shown, after the log', () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    const b = joined(hub, 'b');
    assert.equal(hub.submit(a, [insert(1, 'a', null, 'x')]), null);
    hub.presence(a, cursor(1));
    hub.presence(b, cursor(1));
    hub.presence(b, null);
    const c = joined(hub, 'c');
    assert.deepEqual(c.take(), [
      { type: 'welcome', protocol: 1, doc: 'd', seq: 1 },
      { type: 'ops', from: 1, ops: [insert(1, 'a', null, 'x')] },
      { type: 'presence', replica: 'a', cursor: cursor(1) },
    ]);
  });

  test('a member who leaves is announced with cursor null', () => {
    const hub = new DocumentHub('d');
    const a = joined(hub, 'a');
    const b = joined(hub, 'b');
    b.take();
    hub.leave(a);
    assert.deepEqual(b.take(), [{ type: 'presence', replica: 'a', cursor: null }]);
    hub.leave(a);
    assert.deepEqual(b.take(), [], 'leaving twice announces once');
    assert.equal(hub.members, 1);
  });
});

describe('truncate', () => {
  test('keeps a message within 1,000 code points, counting pairs as one', () => {
    assert.equal(truncate('short'), 'short');
    const exact = '😀'.repeat(1_000);
    assert.equal(truncate(exact), exact);
    const cut = truncate('😀'.repeat(1_001));
    assert.equal(Array.from(cut).length, 1_000);
    assert.ok(cut.endsWith('😀…'));
    // The cut message still encodes.
    assert.doesNotThrow(() =>
      encodeServerMessage({ type: 'error', code: 'refused-op', message: cut }),
    );
  });
});
