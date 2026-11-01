// Re-issuing unsent inserts after a snapshot that collected their origins (release review of day 5). A client offline
// types after text that others then delete; the server collects those tombstones; the client rebuilds from the
// snapshot and must end with the text a server that never collects would show. The property is the release review's
// fuzzer (which found two inserts after one collected element reordered, and an insert crossing visible text when
// counters tie), made a test, with replica names on both sides of the client's so that counter ties order both ways.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  Rga,
  decodeClientMessage,
  encodeServerMessage,
  type ClientMessage,
  type InsertOp,
  type Op,
  type ServerMessage,
} from '@coedit/crdt';
import { SyncClient, type SocketLike } from '../src/sync.ts';

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: ClientMessage[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(decodeClientMessage(data));
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: ServerMessage): void {
    this.onmessage?.({ data: encodeServerMessage(message) });
  }
  take(): ClientMessage[] {
    return this.sent.splice(0);
  }
}

function client(replica = 'me') {
  const sockets: FakeSocket[] = [];
  const sync = new SyncClient({
    url: 'ws://test/sync',
    doc: 'd',
    replica,
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    backoffMs: { initial: 1, max: 4 },
    random: () => 1,
  });
  return { sync, latest: () => sockets.at(-1) as FakeSocket };
}

const opsOf = (messages: ClientMessage[]) =>
  messages.flatMap((m) => (m.type === 'ops' ? m.ops : []));

/** xorshift32: the same sessions on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

interface Census {
  collected: number;
  reissued: number;
  reissuedSessions: number;
  severalReissued: number;
  diverged: string[];
}

/** One session: live editing by `me` and three others, then `me` offline while the others mostly delete. */
function session(seed: number, others: readonly string[], census: Census, late = 0): void {
  const r = rng(seed);
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)] as T;
  const reps = new Map(others.map((n) => [n, { rga: new Rga(n), at: 0 }]));
  const log: Op[] = [];
  const catchUp = (rep: { rga: Rga; at: number }, to: number) => {
    for (; rep.at < to; rep.at++) rep.rga.apply(log[rep.at] as Op);
  };
  const randomEdit = (rga: Rga): Op[] => {
    const len = rga.length;
    if (len > 0 && r() < 0.45) {
      const i = Math.floor(r() * len);
      return rga.edit(i, Math.min(len - i, 1 + Math.floor(r() * 2)), '');
    }
    return rga.edit(Math.floor(r() * (len + 1)), 0, pick(['a', 'b', 'c', 'de', 'f']));
  };
  const { sync, latest } = client();
  sync.start();
  latest().open();
  latest().take();
  latest().receive({ type: 'welcome', protocol: 1, doc: 'd', seq: 0 });
  // A mirror replica under the same id makes the same edits with the same ids: what `me` meant, for the server that
  // never collects.
  const mirror = new Rga('me');
  let meAt = 0;
  const feedMe = () => {
    if (meAt === log.length) return;
    latest().receive({ type: 'ops', from: meAt + 1, ops: log.slice(meAt) });
    for (const op of log.slice(meAt)) mirror.apply(op);
    meAt = log.length;
  };
  const edit = (i: number, d: number, t: string): Op[] => {
    sync.edit(i, d, t);
    return mirror.edit(i, d, t);
  };
  const live = 10 + Math.floor(r() * 15);
  for (let s = 0; s < live; s++) {
    if (r() < 0.3) {
      feedMe();
      const len = sync.rga.length;
      if (len > 0 && r() < 0.3) edit(Math.floor(r() * len), 1, '');
      else edit(Math.floor(r() * (len + 1)), 0, pick(['m', 'n', 'op']));
      log.push(...opsOf(latest().take()));
      feedMe();
    } else {
      const rep = reps.get(pick(others)) as { rga: Rga; at: number };
      catchUp(rep, Math.floor(rep.at + r() * (log.length - rep.at + 1)));
      log.push(...randomEdit(rep.rga));
      rep.at = log.length;
    }
  }
  feedMe();
  sync.stop();
  assert.equal(sync.unacknowledged, 0, 'everything live was acknowledged');
  const meant: Op[] = [];
  const offline = 1 + Math.floor(r() * 4);
  for (let s = 0; s < offline; s++) {
    const len = sync.rga.length;
    if (len > 0 && r() < 0.2) meant.push(...edit(Math.floor(r() * len), 1, ''));
    else meant.push(...edit(Math.floor(r() * (len + 1)), 0, pick(['X', 'Y', 'ZW'])));
  }
  const deletes = 5 + Math.floor(r() * 15);
  for (let s = 0; s < deletes; s++) {
    const rep = reps.get(pick(others)) as { rga: Rga; at: number };
    catchUp(rep, log.length);
    const len = rep.rga.length;
    log.push(
      ...(len > 0 && r() < 0.65 ? rep.rga.edit(Math.floor(r() * len), 1, '') : randomEdit(rep.rga)),
    );
    rep.at = log.length;
  }
  const server = new Rga('server');
  log.forEach((op, i) => server.apply(op, i + 1));
  const collected = server.collect(log.length);
  census.collected += collected;
  const snapshotAt = server.snapshot();
  // Text one of the others types after the snapshot is taken: logged after it, it reaches the client after the
  // rebuild. A writer that has applied the whole log (the others above may have skipped entries, and a real server
  // would refuse an edit naming a collected element with resync).
  const after: Op[] = [];
  if (late > 0) {
    const writer = new Rga(pick(others));
    for (const op of log) writer.apply(op);
    for (let s = 0; s < late; s++) {
      for (const op of randomEdit(writer)) {
        log.push(op);
        after.push(op);
        server.apply(op, log.length);
      }
    }
  }
  const seq = log.length - after.length;
  const never = new Rga('never');
  for (const op of [...log, ...meant]) never.apply(op);

  sync.start();
  latest().open();
  latest().take();
  latest().receive({ type: 'welcome', protocol: 1, doc: 'd', seq });
  if (collected > 0) latest().receive({ type: 'collected', spans: server.collectedSpans() });
  latest().receive({ type: 'snapshot', seq, ops: snapshotAt, last: true });
  assert.equal(sync.status, 'online', `seed ${seed}: ${sync.detail}`);
  const sent = opsOf(latest().take());
  if (after.length > 0) latest().receive({ type: 'ops', from: seq + 1, ops: after });
  const original = new Set(meant.map((op) => JSON.stringify(op)));
  const reissued = sent.filter(
    (op) => op.type === 'insert' && !original.has(JSON.stringify(op)),
  ).length;
  census.reissued += reissued;
  if (reissued > 0) census.reissuedSessions++;
  if (reissued > 1) census.severalReissued++;
  for (const op of sent) server.apply(op, log.length + 1);
  assert.equal(server.text(), sync.rga.text(), `seed ${seed}: the server and the client converge`);
  if (server.text() !== never.text()) {
    census.diverged.push(
      `seed ${seed}: ${JSON.stringify(server.text())} vs ${JSON.stringify(never.text())}`,
    );
  }
}

describe('re-issuing unsent inserts after a collecting snapshot', () => {
  for (const others of [
    ['x', 'y', 'z'],
    ['a', 'n', 'z'],
  ]) {
    test(`ends with the never-collecting text (others ${others.join(', ')}; 1,000 sessions)`, () => {
      const census: Census = {
        collected: 0,
        reissued: 0,
        reissuedSessions: 0,
        severalReissued: 0,
        diverged: [],
      };
      for (let seed = 1; seed <= 1000; seed++) session(seed, others, census);
      assert.deepEqual(census.diverged, []);
      // So a generator that stopped reaching the re-issue fails here rather than passing on nothing.
      assert.ok(census.collected > 5000, `${census.collected} collected`);
      assert.ok(census.reissuedSessions > 400, `${census.reissuedSessions} sessions re-issued`);
      assert.ok(census.severalReissued > 200, `${census.severalReissued} re-issued several`);
    });
  }

  test('converges with text typed after the snapshot, whose order next to re-issued text may differ', (t) => {
    // Text logged after the snapshot is concurrent with the re-issued inserts, and where it typed at the same spot
    // RGA orders the two by id; the collected element it was ordered against without collection is gone (release
    // review, round 2). So only convergence is asserted, and how often the order differed is reported.
    const census: Census = {
      collected: 0,
      reissued: 0,
      reissuedSessions: 0,
      severalReissued: 0,
      diverged: [],
    };
    for (let seed = 1; seed <= 1000; seed++) session(seed, ['a', 'n', 'z'], census, 3);
    assert.ok(census.reissuedSessions > 400, `${census.reissuedSessions} sessions re-issued`);
    t.diagnostic(
      `${census.reissuedSessions} of 1,000 sessions re-issued; ${census.diverged.length} ended in another order ` +
        'than never collecting (all converged)',
    );
  });

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

  /** x typed "pt" (entries 1, 2); me applied them and went offline; x then deleted t (3), which was collected. */
  function afterCollectedT() {
    const log: Op[] = [
      insert(1, 'x', null, 'p'),
      insert(2, 'x', [1, 'x'], 't'),
      { type: 'delete', spans: [{ replica: 'x', counter: 2, length: 1 }] },
    ];
    const server = new Rga('server');
    log.forEach((op, i) => server.apply(op, i + 1));
    assert.equal(server.collect(3), 1);
    const { sync, latest } = client();
    sync.start();
    latest().open();
    latest().take();
    latest().receive({ type: 'welcome', protocol: 1, doc: 'd', seq: 2 });
    latest().receive({ type: 'ops', from: 1, ops: log.slice(0, 2) });
    sync.stop();
    const rejoin = () => {
      sync.start();
      latest().open();
      latest().take();
      latest().receive({ type: 'welcome', protocol: 1, doc: 'd', seq: 3 });
      latest().receive({ type: 'collected', spans: server.collectedSpans() });
      latest().receive({ type: 'snapshot', seq: 3, ops: server.snapshot(), last: true });
      assert.equal(sync.status, 'online');
      return latest().take();
    };
    return { sync, server, rejoin };
  }

  test('a later delete of re-issued text names the new ids', () => {
    const { sync, server, rejoin } = afterCollectedT();
    sync.edit(2, 0, 'XYZ'); // 3@me..5@me after t: "ptXYZ"
    sync.edit(2, 1, ''); // deletes X (3@me): "ptYZ"
    const sent = opsOf(rejoin());
    // XYZ re-issued as 2@me..4@me after p (the counters go on from the snapshot's highest, 1@x: no one has seen
    // 3@me..5@me, so reusing them is safe); the delete names 2@me, not 3@me, which is now Y.
    assert.deepEqual(sent, [
      insert(2, 'me', [1, 'x'], 'XYZ'),
      { type: 'delete', spans: [{ replica: 'me', counter: 2, length: 1 }] },
    ]);
    for (const op of sent) server.apply(op, 4);
    assert.equal(server.text(), 'pYZ');
    assert.equal(sync.rga.text(), 'pYZ');
  });

  test('an insert typed inside re-issued text stays where it was typed', () => {
    const { sync, server, rejoin } = afterCollectedT();
    sync.edit(2, 0, 'XZ'); // 3@me, 4@me after t: "ptXZ"
    sync.edit(3, 0, 'Y'); // 5@me after X: "ptXYZ"
    const sent = opsOf(rejoin());
    for (const op of sent) server.apply(op, 4);
    assert.equal(server.text(), 'pXYZ');
    assert.equal(sync.rga.text(), 'pXYZ');
    assert.equal(sent.length, 2, 'both re-issued');
  });

  test("the client's cursor in re-issued text is renamed too", () => {
    const { sync, rejoin } = afterCollectedT();
    sync.edit(2, 0, 'X'); // 3@me after t
    sync.select({ anchor: 3, head: 3 }); // after X
    const messages = rejoin();
    const presence = messages.filter((m) => m.type === 'presence');
    // X re-issued as 2@me (above 1@x, the snapshot's highest), and the cursor after it with it.
    assert.deepEqual(presence, [
      {
        type: 'presence',
        cursor: { anchor: { replica: 'me', counter: 2 }, head: { replica: 'me', counter: 2 } },
      },
    ]);
  });
  test('an unsent insert whose origin the snapshot lacks, uncollected, stops the client (a server bug)', () => {
    // x typed "p", then "c" and "d" each after p. me, offline, typed X after c and Y after d. c is collected; the
    // snapshot (wrongly) leaves out d without collecting it. Re-issuing starts at X, and Y has nowhere to go.
    const log: Op[] = [
      insert(1, 'x', null, 'p'),
      insert(2, 'x', [1, 'x'], 'c'),
      insert(3, 'x', [1, 'x'], 'd'),
      { type: 'delete', spans: [{ replica: 'x', counter: 2, length: 1 }] },
    ];
    const server = new Rga('server');
    log.forEach((op, i) => server.apply(op, i + 1));
    assert.equal(server.collect(4), 1);
    const { sync, latest } = client();
    sync.start();
    latest().open();
    latest().take();
    latest().receive({ type: 'welcome', protocol: 1, doc: 'd', seq: 3 });
    latest().receive({ type: 'ops', from: 1, ops: log.slice(0, 3) });
    sync.stop();
    assert.equal(sync.rga.text(), 'pdc');
    sync.edit(3, 0, 'X'); // after c
    sync.edit(2, 0, 'Y'); // after d: "pdYcX"
    sync.start();
    latest().open();
    latest().take();
    latest().receive({ type: 'welcome', protocol: 1, doc: 'd', seq: 4 });
    latest().receive({ type: 'collected', spans: server.collectedSpans() });
    const withoutD = server
      .snapshot()
      .filter((op) => !(op.type === 'insert' && op.id.counter === 3));
    latest().receive({ type: 'snapshot', seq: 4, ops: withoutD, last: true });
    assert.equal(sync.status, 'failed');
    assert.match(sync.detail, /neither the snapshot nor the outbox/);
  });
});
