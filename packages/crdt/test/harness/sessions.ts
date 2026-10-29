/**
 * Editing sessions for the RGA's properties: three replicas edit concurrently and now and then catch up on
 * everything made so far. A session is the list of every operation made, in the order made (a causal order).
 */
import fc from 'fast-check';
import type { Op } from '../../src/protocol.ts';
import { Rga } from '../../src/rga.ts';

const NAMES = ['m', 'Z', 'b'] as const;

export type Step =
  | {
      readonly kind: 'edit';
      readonly by: number;
      readonly at: number;
      readonly deleteCount: number;
      readonly text: string;
    }
  | { readonly kind: 'sync'; readonly by: number };

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record(
      {
        kind: fc.constant('edit' as const),
        by: fc.nat({ max: NAMES.length - 1 }),
        at: fc.nat(),
        deleteCount: fc.nat({ max: 3 }),
        text: fc.string({ unit: fc.constantFrom('a', 'b', '😀'), maxLength: 3 }),
      },
      { noNullPrototype: true },
    ),
  },
  {
    weight: 1,
    arbitrary: fc.record(
      { kind: fc.constant('sync' as const), by: fc.nat({ max: NAMES.length - 1 }) },
      { noNullPrototype: true },
    ),
  },
);

/**
 * Every operation of an editing session in which replicas edit concurrently and now and then catch up on
 * everything made so far, in the order they were made (a causal order).
 */
export function session(steps: readonly Step[]): Op[] {
  const replicas = NAMES.map((name) => new Rga(name));
  const applied = NAMES.map(() => 0);
  const ops: Op[] = [];
  for (const s of steps) {
    const r = replicas[s.by] as Rga;
    if (s.kind === 'sync') {
      for (const op of ops.slice(applied[s.by])) r.apply(op);
    } else {
      const index = s.at % (r.length + 1);
      ops.push(...r.edit(index, Math.min(s.deleteCount, r.length - index), s.text));
    }
    applied[s.by] = s.kind === 'sync' ? ops.length : (applied[s.by] as number);
  }
  return ops;
}

/** Sessions of up to 30 steps: 'max' because fast-check's default size stops arrays at about 10 items. */
export const sessions: fc.Arbitrary<Op[]> = fc
  .array(step, { maxLength: 30, size: 'max' })
  .map(session);
