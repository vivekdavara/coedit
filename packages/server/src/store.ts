/**
 * A document on disk (DESIGN.md "Persistence (day 4)"): its log, in segments, and its newest snapshot, in one
 * directory per document.
 *
 *   log-<first>.jsonl       log entries first, first + 1, ...: one line each, {"seq":n,"op":<the op>}
 *   snapshot-<seq>.jsonl    the operations that rebuild the document after entry seq (Rga.snapshot): a header line
 *                           {"seq":s,"ops":n}, then the n operations, one per line
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
import { JsonError, ProtocolError, encodeOp, parseJson, validateOp } from '@coedit/crdt';

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
  readonly snapshot: { readonly seq: number; readonly ops: readonly string[] } | null;
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
    const dir = path.join(root, directoryName(doc));
    fs.mkdirSync(dir, { recursive: true });
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
    if (segments.length === 0) {
      fs.writeFileSync(path.join(dir, `log-${pad(first)}.jsonl`), '', { flag: 'wx' });
      segments.push({ first, last: first - 1 });
      if (fsync) syncDirectory(dir);
    }
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
   * segment, and deletes the older snapshots and every segment holding only entries before `keepFrom`.
   */
  snapshot(ops: readonly string[], keepFrom: number): void {
    this.#open();
    const seq = this.#last;
    const name = `snapshot-${pad(seq)}.jsonl`;
    const tmp = path.join(this.dir, `${name}.tmp`);
    let text = `{"seq":${seq},"ops":${ops.length}}\n`;
    for (const op of ops) text += `${op}\n`;
    const fd = fs.openSync(tmp, 'w');
    try {
      writeAll(fd, Buffer.from(text, 'utf8'));
      if (this.#fsync) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, path.join(this.dir, name));
    // A new segment for the entries after it, unless the last one is still empty.
    const tail = this.#segments.at(-1) as { first: number; last: number };
    if (tail.last >= tail.first) {
      const file = path.join(this.dir, `log-${pad(seq + 1)}.jsonl`);
      const next = fs.openSync(file, 'wx');
      fs.closeSync(this.#fd);
      this.#fd = next;
      this.#segments.push({ first: seq + 1, last: seq });
    }
    if (this.#fsync) syncDirectory(this.dir);
    for (const other of fs.readdirSync(this.dir)) {
      if (SNAPSHOT.test(other) && other < name) fs.rmSync(path.join(this.dir, other));
    }
    while (this.#segments.length > 1 && (this.#segments[0] as { last: number }).last < keepFrom) {
      const old = this.#segments.shift() as { first: number };
      fs.rmSync(path.join(this.dir, `log-${pad(old.first)}.jsonl`));
    }
    if (this.#fsync) syncDirectory(this.dir);
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
): { entries: string[]; torn: number } {
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
  if (read.rest > 0) {
    // An append the process didn't finish. Nothing in it was relayed (the hub relays only after the append).
    fs.truncateSync(file, read.bytes);
  }
  return { entries, torn: read.rest };
}

function readSnapshot(file: string): { seq: number; ops: string[] } {
  const read = lines(file);
  if (read.rest > 0) throw new StoreError(file, 'ends with an unfinished line');
  const [header, ...rest] = read.lines;
  if (header === undefined) throw new StoreError(file, 'empty');
  const value = parseLine(file, 1, header);
  const ok =
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    Number.isSafeInteger((value as { seq?: unknown }).seq) &&
    Number.isSafeInteger((value as { ops?: unknown }).ops);
  if (!ok) throw new StoreError(file, 'line 1: not {"seq":n,"ops":n}');
  const { seq, ops: count } = value as { seq: number; ops: number };
  const name = Number((SNAPSHOT.exec(path.basename(file)) as RegExpExecArray)[1]);
  if (seq !== name)
    throw new StoreError(file, `holds the snapshot after entry ${seq}, not ${name}`);
  if (rest.length !== count) {
    throw new StoreError(file, `holds ${rest.length} operations, but its header says ${count}`);
  }
  return { seq, ops: rest.map((line, i) => checkedOp(file, i + 2, parseLine(file, i + 2, line))) };
}
