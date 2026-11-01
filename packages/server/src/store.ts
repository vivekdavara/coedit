/**
 * A document on disk (DESIGN.md "Persistence (day 4)"): its log, in segments, and its newest snapshot, in one
 * directory per document.
 *
 *   log-<first>.jsonl       log entries first, first + 1, ...: one line each, {"seq":n,"op":<the op>}
 *   snapshot-<seq>.jsonl    the document after entry seq: a header line {"seq":s,"ops":n,"collected":m}, then the n
 *                           operations that rebuild it (Rga.snapshot), one a line, then the m spans of ids it has
 *                           collected (Rga.collectedSpans), one a line (a header without "collected" has none)
 *
 * Numbers in names have 16 digits, so names sort as their numbers do. Entries are appended (and fsynced, by default)
 * before the hub relays them, so an operation anyone has seen is on disk. A crash in the middle of an append leaves
 * part of a line at the end of the last segment: opening drops it and truncates the file there. Nothing that was
 * cut off had been relayed, and its sender still has it in its outbox. Anything else that doesn't read back exactly
 * (a bad line before the end, a gap in the numbers, a snapshot that doesn't parse) refuses the open, rather than
 * serve a document with parts missing.
 *
 * A snapshot is written to a temporary file, synced and renamed into place, so a crash leaves either the old or the
 * new one. Then a new segment starts, and the segments from before the previous snapshot are deleted: what stays
 * on disk is the newest snapshot and the entries since the previous one, so a client that missed less than a
 * snapshot interval still catches up from the log.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  JsonError,
  MAX_SPAN_LENGTH,
  ProtocolError,
  encodeOp,
  parseJson,
  validateOp,
  type Span,
} from '@coedit/crdt';

export interface StoreOptions {
  /**
   * Whether to fsync each append, and each snapshot and directory change (default true). Off, an entry survives the
   * server's process crashing (it's in the operating system's cache) but not the machine losing power.
   */
  readonly fsync?: boolean;
}

/** What a document's directory held when it was opened. */
export interface Loaded {
  /** The newest snapshot, or null: the log entry it's the state after, and its operations as encodeOp writes them. */
  readonly snapshot: {
    readonly seq: number;
    readonly ops: readonly string[];
    readonly collected: readonly Span[];
  } | null;
  /** The sequence number of `entries[0]` (or of the next entry, when there are none). */
  readonly first: number;
  /** The log entries kept, as encodeOp writes them: from the previous snapshot on. */
  readonly entries: readonly string[];
  /** Bytes dropped from the end of the last segment: an append cut off by a crash. */
  readonly torn: number;
}

/** A document's directory that doesn't read back as the store wrote it. */
export class StoreError extends Error {
  constructor(file: string, problem: string) {
    super(`${file}: ${problem}`);
    this.name = 'StoreError';
  }
}

/**
 * A snapshot renamed into place whose directory then couldn't be synced (DocumentStore.snapshot). The store is still
 * usable, but whoever holds a copy of the document must stop using it and load the document again.
 */
export class UnsyncedSnapshotError extends Error {
  constructor(dir: string, name: string, cause: unknown) {
    super(`${dir}: ${name} is in place, but syncing the directory failed`, { cause });
    this.name = 'UnsyncedSnapshotError';
  }
}

const SEGMENT = /^log-(\d{16})\.jsonl$/;
const SNAPSHOT = /^snapshot-(\d{16})\.jsonl$/;

/**
 * The directory name for a document. Names are 1 to 64 characters of A-Z a-z 0-9 _ -, but macOS's file systems
 * ignore case by default, so "Notes" and "notes" would share one directory: each capital letter is written as `^`
 * and the letter in lower case ("^notes"), which no name contains and no file system folds.
 */
export function directoryName(doc: string): string {
  return doc.replace(/[A-Z]/g, (c) => `^${c.toLowerCase()}`);
}

const pad = (n: number) => String(n).padStart(16, '0');

export class DocumentStore {
  readonly dir: string;
  readonly #fsync: boolean;
  #fd: number;
  /** The last entry's sequence number. */
  #last: number;
  /** The segments on disk: each one's first entry, and its last (first - 1 while empty), oldest first. */
  readonly #segments: { first: number; last: number }[];
  #closed = false;

  private constructor(
    dir: string,
    fsync: boolean,
    fd: number,
    last: number,
    segments: { first: number; last: number }[],
  ) {
    this.dir = dir;
    this.#fsync = fsync;
    this.#fd = fd;
    this.#last = last;
    this.#segments = segments;
  }

  /** Opens (creating it if need be) the directory of `doc` under `root`, and reads back what it holds. */
  static open(
    root: string,
    doc: string,
    options: StoreOptions = {},
  ): { store: DocumentStore; loaded: Loaded } {
    const fsync = options.fsync ?? true;
    const dir = path.resolve(root, directoryName(doc));
    const created = fs.mkdirSync(dir, { recursive: true });
    if (fsync && created !== undefined) {
      // Each directory made here is an entry in its parent, and until the parent is synced a power loss can take the
      // new directory with every entry fsynced inside it (review of day 4).
      for (let d = dir; ; d = path.dirname(d)) {
        syncDirectory(path.dirname(d));
        if (d === path.resolve(created)) break;
      }
    }
    const names = fs.readdirSync(dir);
    // A snapshot that was being written when the process stopped.
    for (const name of names) if (name.endsWith('.tmp')) fs.rmSync(path.join(dir, name));

    let snapshot: Loaded['snapshot'] = null;
    const snapshots = names.filter((n) => SNAPSHOT.test(n)).sort();
    const newest = snapshots.at(-1);
    if (newest !== undefined) snapshot = readSnapshot(path.join(dir, newest));

    const segmentNames = names.filter((n) => SEGMENT.test(n)).sort();
    const segments: { first: number; last: number }[] = [];
    const entries: string[] = [];
    let torn = 0;
    // The torn tail to cut off, once everything else has been checked: a document that's refused is left as it was.
    let tear: { file: string; at: number } | null = null;
    let first = 0;
    let next = 0;
    for (let s = 0; s < segmentNames.length; s++) {
      const name = segmentNames[s] as string;
      const file = path.join(dir, name);
      const start = Number((SEGMENT.exec(name) as RegExpExecArray)[1]);
      if (s === 0) {
        first = start;
        next = start;
      } else if (start !== next) {
        throw new StoreError(
          file,
          `starts at entry ${start}, but the segment before ended at ${next - 1}`,
        );
      }
      const read = readSegment(file, start, s === segmentNames.length - 1);
      for (const entry of read.entries) entries.push(entry);
      if (read.torn > 0) tear = { file, at: read.bytes };
      torn += read.torn;
      segments.push({ first: start, last: start + read.entries.length - 1 });
      next = start + read.entries.length;
    }
    if (segments.length === 0) {
      // A new document, or one whose log was all before its snapshot.
      first = (snapshot?.seq ?? 0) + 1;
      next = first;
    }
    if (snapshot !== null && (first > snapshot.seq + 1 || next - 1 < snapshot.seq)) {
      throw new StoreError(
        dir,
        `the snapshot is after entry ${snapshot.seq}, but the log holds entries ${first} to ${next - 1}`,
      );
    }
    if (snapshot === null && first !== 1) {
      throw new StoreError(dir, `no snapshot, and the log starts at entry ${first}, not 1`);
    }
    if (tear !== null) {
      // An append the process didn't finish. Nothing in it was relayed (the hub relays only after the append).
      fs.truncateSync(tear.file, tear.at);
    }
    if (segments.length === 0) {
      fs.writeFileSync(path.join(dir, `log-${pad(first)}.jsonl`), '', { flag: 'wx' });
      segments.push({ first, last: first - 1 });
    }
    // Synced at every open, not only when a segment is made here: a snapshot or segment left in place by a snapshot
    // whose directory sync failed (UnsyncedSnapshotError) is made durable before anything is appended after it.
    if (fsync) syncDirectory(dir);
    const tail = segments.at(-1) as { first: number; last: number };
    const fd = fs.openSync(path.join(dir, `log-${pad(tail.first)}.jsonl`), 'a');
    const store = new DocumentStore(dir, fsync, fd, next - 1, segments);
    return { store, loaded: { snapshot, first, entries, torn } };
  }

  /** The last entry's sequence number (0 for none). */
  get last(): number {
    return this.#last;
  }

  /**
   * Appends entries `seq`, `seq + 1`, ... (encodeOp's text of each), and fsyncs them unless told not to. Throws
   * whatever the file system throws (a full disk): then part of them may be on disk, and the store must be closed
   * and the document opened again, which reads back what got there (a torn last line dropped).
   */
  append(seq: number, entries: readonly string[]): void {
    this.#open();
    if (seq !== this.#last + 1) throw new Error(`entry ${seq} appended after ${this.#last}`);
    if (entries.length === 0) return;
    let text = '';
    for (let i = 0; i < entries.length; i++) text += `{"seq":${seq + i},"op":${entries[i]}}\n`;
    writeAll(this.#fd, Buffer.from(text, 'utf8'));
    if (this.#fsync) fs.fsyncSync(this.#fd);
    this.#last += entries.length;
    (this.#segments.at(-1) as { last: number }).last = this.#last;
  }

  /**
   * Writes a snapshot after the last entry (`ops`: Rga.snapshot's operations as encodeOp writes them), starts a new
   * segment, and deletes the older snapshots and every segment holding only entries before `keepFrom`. Throws if the
   * snapshot couldn't be written (its temporary file is removed: the store is as it was), or, as an
   * UnsyncedSnapshotError, if it was renamed into place but the directory couldn't be synced: then the snapshot (and
   * a new segment) are in the directory but may not survive a power loss, so the caller's copy of the document can
   * no longer be trusted to match what a reload finds (release review), and nothing older has been deleted. A new
   * segment that can't be started or a deletion that fails is logged, and tried again at the next snapshot.
   */
  snapshot(ops: readonly string[], keepFrom: number, collected: readonly Span[] = []): void {
    this.#open();
    const seq = this.#last;
    const name = `snapshot-${pad(seq)}.jsonl`;
    const tmp = path.join(this.dir, `${name}.tmp`);
    let text = `{"seq":${seq},"ops":${ops.length},"collected":${collected.length}}\n`;
    for (const op of ops) text += `${op}\n`;
    for (const { replica, counter, length } of collected) {
      text += `${JSON.stringify({ replica, counter, length })}\n`;
    }
    try {
      const fd = fs.openSync(tmp, 'w');
      try {
        writeAll(fd, Buffer.from(text, 'utf8'));
        if (this.#fsync) fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, path.join(this.dir, name));
    } catch (error) {
      // None of it stays: a failure that lasts would otherwise leave a whole copy of the document per attempt
      // (review of day 4). If even this fails, the next open removes it.
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // (see above)
      }
      throw error;
    }
    // A new segment for the entries after it, unless the last one is still empty. The snapshot is in place either
    // way, so failing to start one is only logged: appends go on in the segment they were in, and the next snapshot
    // tries again. (Thrown, it made the hub count the snapshot as failed and keep every older one: one more full
    // snapshot on disk an interval, review of day 4.)
    const tail = this.#segments.at(-1) as { first: number; last: number };
    if (tail.last >= tail.first) {
      try {
        const next = fs.openSync(path.join(this.dir, `log-${pad(seq + 1)}.jsonl`), 'wx');
        const old = this.#fd;
        this.#fd = next;
        this.#segments.push({ first: seq + 1, last: seq });
        try {
          fs.closeSync(old);
        } catch {
          // Its entries are written (and synced, with fsync on); a descriptor that won't close is only lost.
        }
      } catch (error) {
        console.error(
          `coedit: starting a new segment in ${this.dir} failed; appending to the last one`,
          error,
        );
      }
    }
    if (this.#fsync) {
      try {
        syncDirectory(this.dir);
      } catch (error) {
        throw new UnsyncedSnapshotError(this.dir, name, error);
      }
    }
    this.#prune(name, keepFrom);
  }

  /**
   * Deletes the snapshots older than `name` and the segments holding only entries before `keepFrom`. Only logs a
   * failure: what it couldn't delete is tried again at the next snapshot, and a segment leaves the list only once
   * its file is gone. Forgetting one whose file stayed made the document unopenable a few snapshots later, once the
   * segments after it were deleted and it was followed by a gap (review of day 4).
   */
  #prune(name: string, keepFrom: number): void {
    try {
      for (const other of fs.readdirSync(this.dir)) {
        if (SNAPSHOT.test(other) && other < name)
          fs.rmSync(path.join(this.dir, other), { force: true });
      }
      while (this.#segments.length > 1 && (this.#segments[0] as { last: number }).last < keepFrom) {
        const old = this.#segments[0] as { first: number };
        // force: a file already gone (deleted by hand) mustn't stop every later prune (review 2 of day 4).
        fs.rmSync(path.join(this.dir, `log-${pad(old.first)}.jsonl`), { force: true });
        this.#segments.shift();
      }
      if (this.#fsync) syncDirectory(this.dir);
    } catch (error) {
      console.error(
        `coedit: deleting old files of ${this.dir} failed; trying again at the next snapshot`,
        error,
      );
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    fs.closeSync(this.#fd);
  }

  #open(): void {
    if (this.#closed) throw new Error(`the store of ${this.dir} is closed`);
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  for (let at = 0; at < bytes.length;) at += fs.writeSync(fd, bytes, at, bytes.length - at);
}

function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A file's complete lines, and how many bytes follow the last newline. */
function lines(file: string): { lines: string[]; rest: number; bytes: number } {
  const bytes = fs.readFileSync(file);
  const end = bytes.lastIndexOf(0x0a) + 1;
  let text: string;
  try {
    text = utf8.decode(bytes.subarray(0, end));
  } catch {
    throw new StoreError(file, 'not UTF-8');
  }
  const all = text === '' ? [] : text.slice(0, -1).split('\n');
  return { lines: all, rest: bytes.length - end, bytes: end };
}

/** Parses one stored line as JSON and checks it the way the protocol checks a message. */
function parseLine(file: string, n: number, line: string): unknown {
  try {
    return parseJson(line);
  } catch (error) {
    if (error instanceof JsonError) throw new StoreError(file, `line ${n}: ${error.message}`);
    throw error;
  }
}

function checkedOp(file: string, n: number, value: unknown): string {
  try {
    return encodeOp(validateOp(value));
  } catch (error) {
    if (error instanceof ProtocolError) throw new StoreError(file, `line ${n}: ${error.message}`);
    throw error;
  }
}

function readSegment(
  file: string,
  first: number,
  isLast: boolean,
): { entries: string[]; torn: number; bytes: number } {
  const read = lines(file);
  if (read.rest > 0 && !isLast) {
    throw new StoreError(
      file,
      `ends with ${read.rest} bytes of an unfinished line, but isn't the last segment`,
    );
  }
  const entries: string[] = [];
  for (let i = 0; i < read.lines.length; i++) {
    const value = parseLine(file, i + 1, read.lines[i] as string);
    const ok =
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 2 &&
      'seq' in value &&
      'op' in value;
    if (!ok) throw new StoreError(file, `line ${i + 1}: not {"seq":n,"op":...}`);
    const { seq, op } = value;
    if (seq !== first + i) {
      throw new StoreError(file, `line ${i + 1}: entry ${String(seq)} where ${first + i} belongs`);
    }
    entries.push(checkedOp(file, i + 1, op));
  }
  return { entries, torn: read.rest, bytes: read.bytes };
}

function readSnapshot(file: string): { seq: number; ops: string[]; collected: Span[] } {
  const read = lines(file);
  if (read.rest > 0) throw new StoreError(file, 'ends with an unfinished line');
  const [header, ...rest] = read.lines;
  if (header === undefined) throw new StoreError(file, 'empty');
  const value = parseLine(file, 1, header);
  const keys = typeof value === 'object' && value !== null ? Object.keys(value).sort().join() : '';
  const ok =
    !Array.isArray(value) &&
    (keys === 'ops,seq' || keys === 'collected,ops,seq') &&
    Number.isSafeInteger((value as { seq?: unknown }).seq) &&
    Number.isSafeInteger((value as { ops?: unknown }).ops) &&
    Number.isSafeInteger((value as { collected?: unknown }).collected ?? 0);
  if (!ok) throw new StoreError(file, 'line 1: not {"seq":n,"ops":n,"collected":n}');
  const {
    seq,
    ops: count,
    collected: spans = 0,
  } = value as { seq: number; ops: number; collected?: number };
  const name = Number((SNAPSHOT.exec(path.basename(file)) as RegExpExecArray)[1]);
  if (seq !== name)
    throw new StoreError(file, `holds the snapshot after entry ${seq}, not ${name}`);
  if (rest.length !== count + spans) {
    throw new StoreError(
      file,
      `holds ${rest.length} lines after its header, but it says ${count} operations and ${spans} collected spans`,
    );
  }
  const ops = rest
    .slice(0, count)
    .map((line, i) => checkedOp(file, i + 2, parseLine(file, i + 2, line)));
  const collected = rest.slice(count).map((line, i) => {
    const n = count + i + 2;
    const v = parseLine(file, n, line) as {
      replica?: unknown;
      counter?: unknown;
      length?: unknown;
    };
    // Checked as the wire format checks a delete's span.
    try {
      const op = validateOp({ type: 'delete', spans: [v] });
      if (op.type !== 'delete' || (op.spans[0] as Span).length > MAX_SPAN_LENGTH)
        throw new Error('');
      return op.spans[0] as Span;
    } catch (error) {
      if (error instanceof ProtocolError) throw new StoreError(file, `line ${n}: ${error.message}`);
      throw error;
    }
  });
  return { seq, ops, collected };
}
