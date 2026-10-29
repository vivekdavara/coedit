/**
 * RGA as a subject for the network simulator (DESIGN.md "Testing convergence", day 2): each replica checks, on
 * every delivery, that the visible changes `apply` returned turn the text before into the text after.
 */
import { decodeClientMessage, encodeClientMessage, type Op } from '../../src/protocol.ts';
import { Rga, type RgaOptions } from '../../src/rga.ts';
import { replay } from './changes.ts';
import type { Replica, Subject } from './network.ts';

/** What one replica's deliveries did, for the coverage test. */
export interface Counts {
  deliveries: number;
  /** Deliveries after which an operation was waiting. */
  waiting: number;
  /** Deliveries that returned more than one change: an operation released waiting ones, or a scattered delete. */
  multiple: number;
  /** Deliveries that changed nothing (duplicates, echoes, waits). */
  silent: number;
}

export class RgaReplica implements Replica<Op> {
  readonly rga: Rga;
  readonly counts: Counts = { deliveries: 0, waiting: 0, multiple: 0, silent: 0 };

  constructor(name: string, options: RgaOptions = {}) {
    this.rga = new Rga(name, options);
  }

  text(): string {
    return this.rga.text();
  }

  state(): string {
    return this.rga.state();
  }

  receive(op: Op): void {
    const before = this.rga.text();
    const changes = this.rga.apply(op);
    const after = this.rga.text();
    const replayed = replay(before, changes);
    if (replayed !== after) {
      throw new Error(
        `${this.rga.replica}: changes ${JSON.stringify(changes)} turn ${JSON.stringify(before)} into ${JSON.stringify(replayed)}, not ${JSON.stringify(after)}`,
      );
    }
    this.counts.deliveries++;
    if (this.rga.pending > 0) this.counts.waiting++;
    if (changes.length > 1) this.counts.multiple++;
    if (changes.length === 0) this.counts.silent++;
  }
}

/**
 * The wire, for the simulator's `transport`: an operation is encoded as a client's `ops` message and decoded the
 * way the server decodes it, so one that can't survive the strict codec fails the property.
 */
export function wire(op: unknown): Op {
  const message = decodeClientMessage(encodeClientMessage({ type: 'ops', ops: [op as Op] }));
  if (message.type !== 'ops' || message.ops.length !== 1)
    throw new Error('the codec changed an ops message');
  return message.ops[0] as Op;
}

export interface RgaSubjectOptions {
  readonly name?: string;
  /** Each replica's starting clock, by its name (default 0). */
  readonly clock?: (replica: string) => number;
  /** Called with every replica created, so a test can look at them after a schedule. */
  readonly created?: (replica: RgaReplica) => void;
}

export function rgaSubject(options: RgaSubjectOptions = {}): Subject<Op, RgaReplica> {
  return {
    name: options.name ?? 'RGA',
    create(name) {
      const replica = new RgaReplica(name, { clock: options.clock?.(name) ?? 0 });
      options.created?.(replica);
      return replica;
    },
    edit: (replica, index, deleteCount, text) => replica.rga.edit(index, deleteCount, text),
  };
}
