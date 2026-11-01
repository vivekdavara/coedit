// Convergence end to end: sync clients on the real server, driven by generated schedules of edits, dropped
// connections, offline spells and pauses that let messages through. However a schedule goes, once everyone is back
// online and the outboxes are empty, every client's replica must be the server's, state and all, and the text each
// client patched from the reported changes must be its replica's (what the editor shows).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import fc from 'fast-check';
import { startServer, type SyncServer } from '@coedit/server';
import type { Change } from '@coedit/crdt';
import { SyncClient } from '../src/sync.ts';
import { applyEdit } from '../src/edit.ts';
import { eventually } from './helpers.ts';

type Step =
  | { kind: 'edit'; who: number; at: number; remove: number; text: string }
  | { kind: 'disconnect'; who: number }
  | { kind: 'offline'; who: number }
  | { kind: 'online'; who: number }
  | { kind: 'pause'; ms: number };

const step = (clients: number): fc.Arbitrary<Step> => {
  const who = fc.nat({ max: clients - 1 });
  return fc.oneof(
    {
      weight: 6,
      arbitrary: fc.record({
        kind: fc.constant('edit' as const),
        who,
        at: fc.nat(),
        remove: fc.nat({ max: 3 }),
        text: fc.string({ unit: fc.constantFrom('a', 'b', '😀', '\n'), maxLength: 4 }),
      }),
    },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('disconnect' as const), who }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('offline' as const), who }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('online' as const), who }) },
    {
      weight: 2,
      arbitrary: fc.record({ kind: fc.constant('pause' as const), ms: fc.nat({ max: 15 }) }),
    },
  );
};

const schedule = fc
  .integer({ min: 2, max: 4 })
  .chain((clients) =>
    fc.tuple(fc.constant(clients), fc.array(step(clients), { minLength: 10, maxLength: 80 })),
  );

let server: SyncServer;
let stored: SyncServer;
let docs = 0;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-convergence-'));
before(async () => {
  server = await startServer({ port: 0 });
  // Day 4: a snapshot every 3 entries, collection on, so clients rebuild from snapshots all the time.
  stored = await startServer({ port: 0, dataDir: data, fsync: false, snapshotEvery: 3 });
});
after(async () => {
  try {
    await server.close();
    await stored.close();
  } finally {
    // Removed however the closes go (some runs left the directory behind).
    fs.rmSync(data, { recursive: true, force: true });
  }
});

/** A client that keeps the text an editor would show: patched by its own edits and the reported changes. */
function makeClient(doc: string, server: SyncServer) {
  let shown = '';
  const client = new SyncClient(
    { url: `ws://${server.host}:${server.port}/sync`, doc, backoffMs: { initial: 2, max: 20 } },
    {
      onChanges: (changes: readonly Change[]) => {
        for (const c of changes) {
          shown = applyEdit(shown, {
            index: c.index,
            deleteCount: c.type === 'delete' ? c.count : 0,
            text: c.type === 'insert' ? c.text : '',
          });
        }
      },
    },
  );
  return {
    client,
    shown: () => shown,
    edit(at: number, remove: number, text: string) {
      const length = client.rga.length;
      const index = at % (length + 1);
      const deleteCount = Math.min(remove, length - index);
      if (deleteCount === 0 && text === '') return;
      client.edit(index, deleteCount, text);
      shown = applyEdit(shown, { index, deleteCount, text });
    },
  };
}

test('clients on the real server converge with it under generated schedules', async () => {
  let edits = 0;
  let drops = 0;
  await fc.assert(
    fc.asyncProperty(schedule, async ([count, steps]) => {
      const doc = `conv-${++docs}`;
      const clients = Array.from({ length: count }, () => makeClient(doc, server));
      for (const c of clients) c.client.start();
      try {
        for (const s of steps) {
          if (s.kind === 'pause') {
            await new Promise((resolve) => setTimeout(resolve, s.ms));
            continue;
          }
          const c = clients[s.who] as (typeof clients)[number];
          if (s.kind === 'edit') {
            c.edit(s.at, s.remove, s.text);
            edits++;
          } else if (s.kind === 'disconnect') {
            c.client.disconnect();
            drops++;
          } else if (s.kind === 'offline') {
            c.client.stop();
          } else {
            c.client.start();
          }
        }
        for (const c of clients) c.client.start();
        await eventually(() => {
          const seq = server.inspect(doc)?.seq ?? 0;
          return clients.every(
            (c) =>
              c.client.status === 'online' && c.client.unacknowledged === 0 && c.client.seq === seq,
          );
        }, 20_000);
        const expected = server.inspect(doc);
        assert.ok(expected !== undefined);
        for (const c of clients) {
          assert.equal(c.client.rga.state(), expected.state);
          assert.equal(c.shown(), expected.text);
          assert.equal(c.client.rga.pending, 0);
        }
      } finally {
        for (const c of clients) c.client.stop();
      }
    }),
    { numRuns: 100 },
  );
  // The schedules did what they're for (fast-check's sizes, not the lengths asked for, set how long they are).
  console.log(`# ${edits} edits, ${drops} dropped connections`);
  // Five runs here: 1,012 to 1,134 edits and 153 to 179 drops; the bound is well under that, for other seeds.
  assert.ok(edits > 700 && drops > 100, `${edits} edits, ${drops} dropped connections`);
});

test('and on a stored server that snapshots every 3 entries and collects tombstones (day 4)', async () => {
  let edits = 0;
  let collected = 0;
  let rebuilt = 0;
  await fc.assert(
    fc.asyncProperty(schedule, async ([count, steps]) => {
      const doc = `stored-${++docs}`;
      const clients = Array.from({ length: count }, () => makeClient(doc, stored));
      for (const c of clients) c.client.start();
      try {
        for (const s of steps) {
          if (s.kind === 'pause') {
            await new Promise((resolve) => setTimeout(resolve, s.ms));
            continue;
          }
          const c = clients[s.who] as (typeof clients)[number];
          if (s.kind === 'edit') {
            c.edit(s.at, s.remove, s.text);
            edits++;
          } else if (s.kind === 'disconnect') c.client.disconnect();
          else if (s.kind === 'offline') c.client.stop();
          else c.client.start();
        }
        for (const c of clients) c.client.start();
        await eventually(() => {
          const seq = stored.inspect(doc)?.seq ?? 0;
          return clients.every(
            (c) =>
              c.client.status === 'online' && c.client.unacknowledged === 0 && c.client.seq === seq,
          );
        }, 20_000);
        const expected = stored.inspect(doc);
        assert.ok(expected !== undefined);
        if (expected.state.includes('| collected')) collected++;
        // A client that kept its replica holds tombstones the server collected; one that rebuilt holds what the
        // server holds. Either way the text, and every position's element, are the same.
        for (const c of clients) {
          assert.equal(c.client.rga.text(), expected.text);
          assert.equal(c.shown(), expected.text);
          assert.equal(c.client.rga.pending, 0);
          if (c.client.rga.state() === expected.state) rebuilt++;
          const first = (clients[0] as (typeof clients)[number]).client.rga;
          for (let i = 0; i <= c.client.rga.length; i++) {
            assert.deepEqual(c.client.rga.idBefore(i), first.idBefore(i));
          }
        }
      } finally {
        for (const c of clients) c.client.stop();
      }
    }),
    { numRuns: 60 },
  );
  console.log(
    `# stored: ${edits} edits; ${collected} of 60 documents collected something; ${rebuilt} clients ended rebuilt`,
  );
  assert.ok(collected > 5, `only ${collected} documents collected anything`);
});
