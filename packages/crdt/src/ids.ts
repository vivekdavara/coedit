/**
 * Element ids: their total order, and a map keyed by them. DESIGN.md "Elements and ids" is the specification.
 */
import type { Id } from './protocol.ts';

/**
 * RGA's order of ids: by counter, then by replica in UTF-16 code-unit order. Negative when `a` comes first.
 *
 * Code-unit order is what JavaScript's `<` gives on strings, and it's the same on every machine. `localeCompare`
 * isn't: it depends on the locale, so two replicas in different locales would place concurrent inserts differently
 * (and within one process the convergence tests can't see it, since every replica shares the locale).
 */
export function compareIds(a: Id, b: Id): number {
  // Comparisons, not `a.counter - b.counter`, so the result never depends on rounding.
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.replica === b.replica) return 0;
  return a.replica < b.replica ? -1 : 1;
}

export function sameId(a: Id | null, b: Id | null): boolean {
  if (a === null || b === null) return a === b;
  return a.counter === b.counter && a.replica === b.replica;
}

/** `counter@replica`, or `HEAD` for null: for error messages and `Rga.state()`. */
export function formatId(id: Id | null): string {
  return id === null ? 'HEAD' : `${id.counter}@${id.replica}`;
}

/** A map from ids to values, one inner map per replica, so a lookup builds no key string. */
export class IdMap<V> {
  readonly #replicas = new Map<string, Map<number, V>>();
  #size = 0;

  get size(): number {
    return this.#size;
  }

  get(id: Id): V | undefined {
    return this.#replicas.get(id.replica)?.get(id.counter);
  }

  has(id: Id): boolean {
    return this.#replicas.get(id.replica)?.has(id.counter) ?? false;
  }

  set(id: Id, value: V): void {
    let counters = this.#replicas.get(id.replica);
    if (counters === undefined) {
      counters = new Map();
      this.#replicas.set(id.replica, counters);
    }
    if (!counters.has(id.counter)) this.#size++;
    counters.set(id.counter, value);
  }

  delete(id: Id): boolean {
    const counters = this.#replicas.get(id.replica);
    if (counters === undefined || !counters.delete(id.counter)) return false;
    if (counters.size === 0) this.#replicas.delete(id.replica);
    this.#size--;
    return true;
  }

  /** Every id held, in id order. */
  ids(): Id[] {
    const ids: Id[] = [];
    for (const [replica, counters] of this.#replicas) {
      for (const counter of counters.keys()) ids.push({ replica, counter });
    }
    return ids.sort(compareIds);
  }
}
