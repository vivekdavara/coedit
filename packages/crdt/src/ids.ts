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
    // Counted after the set succeeds: a Map's set can throw (Rga's capacity keeps it from it).
    const added = !counters.has(id.counter);
    counters.set(id.counter, value);
    if (added) this.#size++;
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

/**
 * Sets of ids as ranges of consecutive counters, per replica, sorted and merged: the ids a replica has collected (day
 * 4), which can be many but come mostly in long runs. Lookups are a binary search.
 */
export class IdRanges {
  /** Per replica: disjoint, non-adjacent [first, last] ranges in counter order. */
  readonly #ranges = new Map<string, [number, number][]>();
  #count = 0;

  /** Ids held. */
  get size(): number {
    return this.#count;
  }

  has(id: Id): boolean {
    return this.overlaps(id.replica, id.counter, id.counter);
  }

  /** Whether any of `replica`'s counters from `first` to `last` is held. */
  overlaps(replica: string, first: number, last: number): boolean {
    const list = this.#ranges.get(replica);
    if (list === undefined) return false;
    // The last range starting at or before `last`.
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((list[mid] as [number, number])[0] <= last) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found >= 0 && (list[found] as [number, number])[1] >= first;
  }

  /** Adds ids (any order, duplicates of held ones allowed). */
  addAll(ids: readonly Id[]): void {
    const byReplica = new Map<string, number[]>();
    for (const { replica, counter } of ids) {
      const counters = byReplica.get(replica);
      if (counters === undefined) byReplica.set(replica, [counter]);
      else counters.push(counter);
    }
    for (const [replica, counters] of byReplica) {
      counters.sort((a, b) => a - b);
      const added: [number, number][] = [];
      for (const c of counters) {
        const last = added.at(-1);
        if (last !== undefined && c <= last[1] + 1) last[1] = Math.max(last[1], c);
        else added.push([c, c]);
      }
      this.#merge(replica, added);
    }
  }

  /** Adds `length` ids of `replica` from `counter`. */
  addSpan(replica: string, counter: number, length: number): void {
    this.#merge(replica, [[counter, counter + length - 1]]);
  }

  /** Every range, by replica in code-unit order then counter, each as a span of at most `maxLength` ids. */
  spans(maxLength: number): { replica: string; counter: number; length: number }[] {
    const spans: { replica: string; counter: number; length: number }[] = [];
    for (const replica of [...this.#ranges.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      for (const [first, last] of this.#ranges.get(replica) as [number, number][]) {
        for (let c = first; c <= last; c += maxLength) {
          spans.push({ replica, counter: c, length: Math.min(maxLength, last - c + 1) });
        }
      }
    }
    return spans;
  }

  /** Merges sorted, merged `added` into `replica`'s ranges. */
  #merge(replica: string, added: readonly [number, number][]): void {
    const old = this.#ranges.get(replica) ?? [];
    const all = [...old, ...added].sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    let count = 0;
    for (const [first, last] of all) {
      const prev = merged.at(-1);
      if (prev !== undefined && first <= prev[1] + 1) prev[1] = Math.max(prev[1], last);
      else merged.push([first, last]);
    }
    for (const [first, last] of merged) count += last - first + 1;
    let before = 0;
    for (const [first, last] of old) before += last - first + 1;
    this.#ranges.set(replica, merged);
    this.#count += count - before;
  }
}
