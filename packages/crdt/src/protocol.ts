/**
 * The wire format: the CRDT's operations and the sync protocol's messages, a strict decoder for each direction,
 * and an encoder that writes one canonical text per message. DESIGN.md "The wire format" and "The sync protocol"
 * are the specification.
 *
 * The decoder refuses anything not exactly as specified, with the path of the offending field. That matters more
 * here than in most protocols: an operation one replica accepts and another refuses, or reads differently, splits
 * the document for good.
 */
import { JsonError, parseJson, type JsonValue } from './json.ts';

/**
 * The sync protocol's version. A client and the server speak only the same version; DESIGN.md "The sync
 * protocol" describes the messages.
 */
export const PROTOCOL_VERSION = 1;

export const MAX_REPLICA_LENGTH = 32;
export const MAX_DOC_LENGTH = 64;
/** Code points in one insert. */
export const MAX_INSERT_LENGTH = 10_000;
export const MAX_SPANS = 1_000;
export const MAX_SPAN_LENGTH = 10_000;
export const MAX_OPS = 1_000;
export const MAX_ERROR_MESSAGE_LENGTH = 1_000;

/** An element's id: unique because a replica never reuses a counter and replicas never share an id. */
export interface Id {
  readonly replica: string;
  readonly counter: number;
}

/** Inserts `text`, one element per code point, ids `id.counter`, `id.counter + 1`, ..., after `origin`. */
export interface InsertOp {
  readonly type: 'insert';
  readonly id: Id;
  /** The element the text goes after; null means the start of the document. */
  readonly origin: Id | null;
  readonly text: string;
}

/** Ids `counter` to `counter + length - 1` of one replica. */
export interface Span {
  readonly replica: string;
  readonly counter: number;
  readonly length: number;
}

export interface DeleteOp {
  readonly type: 'delete';
  readonly spans: readonly Span[];
}

export type Op = InsertOp | DeleteOp;

/** A selection, as positions just after an element (null: the start of the document). */
export interface Cursor {
  readonly anchor: Id | null;
  readonly head: Id | null;
}

export interface Hello {
  readonly type: 'hello';
  readonly protocol: number;
  readonly doc: string;
  readonly replica: string;
  /** The last log sequence number this client has applied; 0 for none. */
  readonly have: number;
}

export interface ClientOps {
  readonly type: 'ops';
  readonly ops: readonly Op[];
}

export interface ClientPresence {
  readonly type: 'presence';
  /** null: hide my cursor. */
  readonly cursor: Cursor | null;
}

export type ClientMessage = Hello | ClientOps | ClientPresence;

export interface Welcome {
  readonly type: 'welcome';
  readonly protocol: number;
  readonly doc: string;
  /** The log's last sequence number when the client joined. */
  readonly seq: number;
}

export interface ServerOps {
  readonly type: 'ops';
  /** The sequence number of `ops[0]`; the rest follow consecutively. */
  readonly from: number;
  readonly ops: readonly Op[];
}

/**
 * Part of a snapshot (day 4): operations that rebuild the document as it was after log entry `seq` (Rga.snapshot),
 * sent instead of the log to a client whose `have` is older than the oldest entry the server keeps. A long snapshot
 * takes several messages, the last with `last: true`; the client has the state after `seq` only then, and the log
 * goes on from `seq + 1`. Unlike `ops`, one may carry no operations (a snapshot of an empty document).
 */
export interface ServerSnapshot {
  readonly type: 'snapshot';
  readonly seq: number;
  readonly ops: readonly Op[];
  readonly last: boolean;
}

/**
 * Ids the server has collected (day 4, DESIGN.md "Tombstones"), sent before the parts of a snapshot: elements that
 * were deleted and are gone for good, so the snapshot doesn't hold them. The client keeps them with the snapshot's
 * replica, and counts an outbox operation that names them as one the server has (it logged it before collecting).
 * At most MAX_SPANS spans a message; there may be several.
 */
export interface ServerCollected {
  readonly type: 'collected';
  readonly spans: readonly Span[];
}

export interface ServerPresence {
  readonly type: 'presence';
  readonly replica: string;
  /** null: that client left or hid its cursor. */
  readonly cursor: Cursor | null;
}

export const ERROR_CODES = [
  'malformed',
  'unsupported-protocol',
  'unexpected-message',
  'refused-op',
  'too-large',
  // The client's `have` is past the end of the server's log: the server lost entries the client applied.
  'ahead-of-server',
  // An operation names an element the server has collected (day 4): the client rebuilds from a snapshot, and sends
  // its unacknowledged edits again against it.
  'resync',
  'server-error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorMessage {
  readonly type: 'error';
  readonly code: ErrorCode;
  readonly message: string;
}

export type ServerMessage =
  Welcome | ServerOps | ServerSnapshot | ServerCollected | ServerPresence | ErrorMessage;

/** A message that isn't exactly as specified. `path` names the field, e.g. `ops[2].origin.counter`. */
export class ProtocolError extends Error {
  readonly path: string;

  constructor(path: string, problem: string) {
    super(path === '' ? problem : `${path}: ${problem}`);
    this.name = 'ProtocolError';
    this.path = path;
  }
}

export function decodeClientMessage(text: string): ClientMessage {
  return clientMessage(read(text));
}

export function decodeServerMessage(text: string): ServerMessage {
  return serverMessage(read(text));
}

/** Writes a message as its one canonical text, after checking it the way the receiver will. */
export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(clientMessage(message as unknown as JsonValue));
}

export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(serverMessage(message as unknown as JsonValue));
}

/** Checks one operation; returns a copy with its keys in canonical order. */
export function validateOp(value: unknown, path = 'op'): Op {
  return op(value as JsonValue, path);
}

/** The most UTF-8 bytes in one WebSocket message, either way (the server refuses more). */
export const MAX_MESSAGE_BYTES = 1 << 20;

/**
 * Room left in a message for everything but its operations: `{"type":"ops","from":<16 digits>,"ops":[` and `]}`
 * take 47 bytes (batch.test.ts fills batches to the byte).
 */
const OPS_ENVELOPE_BYTES = 64;

/**
 * One operation's canonical text, as the encoders write it inside a message. The sync client and the server keep
 * operations in this form: the client compares its outbox against echoes by it, and the server writes messages
 * from it without encoding each operation again for every message.
 */
export function encodeOp(value: Op): string {
  return JSON.stringify(validateOp(value));
}

/**
 * The client's `ops` message from operations already written by encodeOp; the same text encodeClientMessage
 * writes for them. The operations aren't checked again.
 */
export function encodeClientOps(texts: readonly string[]): string {
  checkBatch(texts);
  return `{"type":"ops","ops":[${texts.join(',')}]}`;
}

/**
 * The server's `snapshot` message from operations already written by encodeOp (none is allowed). Its envelope with
 * the largest `seq` and `"last":false` is 64 bytes, so batches from batchEnd fit it too (batch.test.ts checks).
 */
export function encodeServerSnapshot(seq: number, texts: readonly string[], last: boolean): string {
  if (texts.length > MAX_OPS) {
    throw new ProtocolError('ops', `must be 0 to ${MAX_OPS} operations, not ${texts.length}`);
  }
  integer(seq, 'seq', 0);
  return `{"type":"snapshot","seq":${seq},"ops":[${texts.join(',')}],"last":${last}}`;
}

/** The server's `ops` message, numbered from `from`, from operations already written by encodeOp. */
export function encodeServerOps(from: number, texts: readonly string[]): string {
  checkBatch(texts);
  integer(from, 'from', 1, Number.MAX_SAFE_INTEGER - texts.length + 1);
  return `{"type":"ops","from":${from},"ops":[${texts.join(',')}]}`;
}

function checkBatch(texts: readonly string[]): void {
  if (texts.length === 0 || texts.length > MAX_OPS) {
    throw new ProtocolError('ops', `must be 1 to ${MAX_OPS} operations, not ${texts.length}`);
  }
}

/**
 * Splits operations written by encodeOp into batches that each fit one `ops` message: at most MAX_OPS operations
 * and MAX_MESSAGE_BYTES in all. An operation is at most about 90 KB (a delete of 1,000 spans), so each fits.
 */
export function batchOps(texts: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let start = 0; start < texts.length;) {
    const end = batchEnd(texts, start);
    batches.push(texts.slice(start, end));
    start = end;
  }
  return batches;
}

/**
 * Where the batch that batchOps would start at `start` ends (exclusive), looking at no more operations than it
 * holds: the server's catch-up takes one batch at a time, and measuring 1,000 operations to keep the 25 that fit
 * made a 117 MiB catch-up take 5.5 s instead of 0.18 s (review 2 of day 3).
 */
export function batchEnd(texts: readonly string[], start: number): number {
  const limit = MAX_MESSAGE_BYTES - OPS_ENVELOPE_BYTES;
  let bytes = 0;
  let end = start;
  while (end < texts.length && end - start < MAX_OPS) {
    const size = utf8Length(texts[end] as string) + 1; // and a comma
    if (end > start && bytes + size > limit) break;
    bytes += size;
    end++;
  }
  return end;
}

/** The number of bytes `value` takes in UTF-8. A lone surrogate counts 3, as TextEncoder writes U+FFFD for it. */
export function utf8Length(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function read(text: string): JsonValue {
  try {
    return parseJson(text);
  } catch (error) {
    if (error instanceof JsonError) throw new ProtocolError('', `not valid JSON: ${error.message}`);
    throw error;
  }
}

// Each checker below takes a value that came from parseJson (or from a caller of an encoder), checks it, and
// returns a fresh object with exactly the specified keys in the specified order. The encoders rely on that order
// for their canonical text.

function clientMessage(value: JsonValue): ClientMessage {
  const type = messageType(value, ['hello', 'ops', 'presence']);
  switch (type) {
    case 'hello': {
      const m = fields(value, '', ['type', 'protocol', 'doc', 'replica', 'have']);
      return {
        type,
        protocol: integer(m['protocol'], 'protocol', 1),
        doc: name(m['doc'], 'doc', MAX_DOC_LENGTH),
        replica: name(m['replica'], 'replica', MAX_REPLICA_LENGTH),
        have: integer(m['have'], 'have', 0),
      };
    }
    case 'ops': {
      const m = fields(value, '', ['type', 'ops']);
      return { type, ops: ops(m['ops'], 'ops') };
    }
    case 'presence': {
      const m = fields(value, '', ['type', 'cursor']);
      return { type, cursor: cursorOrNull(m['cursor'], 'cursor') };
    }
  }
}

function serverMessage(value: JsonValue): ServerMessage {
  const type = messageType(value, ['welcome', 'ops', 'snapshot', 'collected', 'presence', 'error']);
  switch (type) {
    case 'welcome': {
      const m = fields(value, '', ['type', 'protocol', 'doc', 'seq']);
      return {
        type,
        protocol: integer(m['protocol'], 'protocol', 1),
        doc: name(m['doc'], 'doc', MAX_DOC_LENGTH),
        seq: integer(m['seq'], 'seq', 0),
      };
    }
    case 'ops': {
      const m = fields(value, '', ['type', 'from', 'ops']);
      const from = integer(m['from'], 'from', 1);
      const list = ops(m['ops'], 'ops');
      if (list.length - 1 > Number.MAX_SAFE_INTEGER - from) {
        throw new ProtocolError('from', 'the last sequence number is past the safe range');
      }
      return { type, from, ops: list };
    }
    case 'snapshot': {
      const m = fields(value, '', ['type', 'seq', 'ops', 'last']);
      const seq = integer(m['seq'], 'seq', 0);
      const raw = m['ops'];
      const list = Array.isArray(raw) && raw.length === 0 ? [] : ops(raw, 'ops');
      const last = m['last'];
      if (typeof last !== 'boolean') throw new ProtocolError('last', 'must be true or false');
      return { type, seq, ops: list, last };
    }
    case 'collected': {
      const m = fields(value, '', ['type', 'spans']);
      const spans = list(m['spans'], 'spans', MAX_SPANS).map((item, i) =>
        span(item, `spans[${i}]`),
      );
      return { type, spans };
    }
    case 'presence': {
      const m = fields(value, '', ['type', 'replica', 'cursor']);
      return {
        type,
        replica: name(m['replica'], 'replica', MAX_REPLICA_LENGTH),
        cursor: cursorOrNull(m['cursor'], 'cursor'),
      };
    }
    case 'error': {
      const m = fields(value, '', ['type', 'code', 'message']);
      const code = m['code'];
      if (typeof code !== 'string' || !(ERROR_CODES as readonly string[]).includes(code)) {
        throw new ProtocolError('code', `must be one of ${ERROR_CODES.join(', ')}`);
      }
      const message = text(m['message'], 'message', 0, MAX_ERROR_MESSAGE_LENGTH);
      return { type, code: code as ErrorCode, message };
    }
  }
}

function messageType<T extends string>(value: JsonValue, types: readonly T[], path = ''): T {
  if (!isObject(value)) throw new ProtocolError(path, 'must be an object');
  if (!Object.hasOwn(value, 'type')) throw new ProtocolError(join(path, 'type'), 'missing');
  const type = value['type'];
  if (typeof type !== 'string' || !(types as readonly string[]).includes(type)) {
    throw new ProtocolError(join(path, 'type'), `must be one of ${types.join(', ')}`);
  }
  return type as T;
}

function op(value: JsonValue, path: string): Op {
  const type = messageType(value, ['insert', 'delete'], path);
  if (type === 'insert') {
    const m = fields(value, path, ['type', 'id', 'origin', 'text']);
    const opId = id(m['id'], `${path}.id`);
    const origin = m['origin'] === null ? null : id(m['origin'], `${path}.origin`);
    const insertText = text(m['text'], `${path}.text`, 1, MAX_INSERT_LENGTH);
    // The elements' counters run from id.counter to id.counter + length - 1. text() has checked the length, so
    // with counters at most MAX - MAX_INSERT_LENGTH + 1 nothing can overflow and the second count is skipped.
    if (opId.counter > Number.MAX_SAFE_INTEGER - MAX_INSERT_LENGTH + 1) {
      lastCounter(opId.counter, codePoints(insertText), `${path}.text`);
    }
    if (origin !== null && origin.counter >= opId.counter) {
      // RGA's ordering rule is only the same everywhere if every element's counter exceeds its origin's
      // (DESIGN.md "Insert").
      throw new ProtocolError(`${path}.origin.counter`, "must be less than the insert's counter");
    }
    return { type, id: opId, origin, text: insertText };
  }
  const m = fields(value, path, ['type', 'spans']);
  const spans = list(m['spans'], `${path}.spans`, MAX_SPANS).map((item, i) =>
    span(item, `${path}.spans[${i}]`),
  );
  return { type, spans };
}

function ops(value: JsonValue | undefined, path: string): Op[] {
  return list(value, path, MAX_OPS).map((item, i) => op(item, `${path}[${i}]`));
}

function id(value: JsonValue | undefined, path: string): Id {
  const m = fields(value, path, ['replica', 'counter']);
  return {
    replica: name(m['replica'], `${path}.replica`, MAX_REPLICA_LENGTH),
    counter: integer(m['counter'], `${path}.counter`, 1),
  };
}

function span(value: JsonValue, path: string): Span {
  const m = fields(value, path, ['replica', 'counter', 'length']);
  const replica = name(m['replica'], `${path}.replica`, MAX_REPLICA_LENGTH);
  const counter = integer(m['counter'], `${path}.counter`, 1);
  const length = integer(m['length'], `${path}.length`, 1, MAX_SPAN_LENGTH);
  lastCounter(counter, length, `${path}.length`);
  return { replica, counter, length };
}

function cursorOrNull(value: JsonValue | undefined, path: string): Cursor | null {
  if (value === null) return null;
  const m = fields(value, path, ['anchor', 'head']);
  return {
    anchor: m['anchor'] === null ? null : id(m['anchor'], `${path}.anchor`),
    head: m['head'] === null ? null : id(m['head'], `${path}.head`),
  };
}

/** Checks that `value` is an object with exactly `keys`; a missing key and an extra key are both refused. */
function fields(
  value: JsonValue | undefined,
  path: string,
  keys: readonly string[],
): Record<string, JsonValue> {
  if (!isObject(value)) throw new ProtocolError(path, 'must be an object');
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new ProtocolError(join(path, key), 'unknown field');
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new ProtocolError(join(path, key), 'missing');
  }
  return value;
}

function list(value: JsonValue | undefined, path: string, max: number): JsonValue[] {
  if (!Array.isArray(value)) throw new ProtocolError(path, 'must be an array');
  // A plain copy, read by index, with the length read once. An encoder's caller could pass an Array subclass (whose
  // map() returns the subclass, which JSON.stringify then writes through its toJSON), an array with its own map
  // property, or one whose index getter appends to it while it's copied (review 2: a live length let that grow
  // past the limit after the check).
  const length = value.length;
  if (length === 0) throw new ProtocolError(path, 'must not be empty');
  if (length > max) throw new ProtocolError(path, `more than ${max} items`);
  const items: JsonValue[] = [];
  for (let i = 0; i < length; i++) items.push(value[i] as JsonValue);
  return items;
}

function integer(
  value: JsonValue | undefined,
  path: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  // Only an encoder's caller can pass NaN, Infinity, a fraction or -0 (parseJson refuses them all).
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0)) {
    throw new ProtocolError(path, 'must be an integer');
  }
  if (value < min || value > max) throw new ProtocolError(path, `must be from ${min} to ${max}`);
  return value;
}

const NAME = /^[A-Za-z0-9_-]+$/;

/** Whether `value` is a valid replica id (1 to 32 characters of A-Z a-z 0-9 _ -). */
export function isReplicaName(value: string): boolean {
  return value.length >= 1 && value.length <= MAX_REPLICA_LENGTH && NAME.test(value);
}

function name(value: JsonValue | undefined, path: string, max: number): string {
  if (typeof value !== 'string') throw new ProtocolError(path, 'must be a string');
  if (value.length < 1 || value.length > max || !NAME.test(value)) {
    throw new ProtocolError(path, `must be 1 to ${max} characters of A-Z a-z 0-9 _ -`);
  }
  return value;
}

/** A string of `min` to `max` code points, with no lone surrogates. */
function text(value: JsonValue | undefined, path: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new ProtocolError(path, 'must be a string');
  // An encoder's caller could pass a lone surrogate (parseJson never returns one); JSON.stringify would escape it
  // and the receiver would refuse the message.
  if (!value.isWellFormed()) throw new ProtocolError(path, 'contains a lone surrogate');
  // Counting code points costs a pass over the string, so the cheap UTF-16 bounds go first: a string has at least
  // half as many code points as code units, and at most as many.
  if (value.length < min || value.length > 2 * max) {
    throw new ProtocolError(path, `must be ${min} to ${max} code points`);
  }
  const n = codePoints(value);
  if (n < min || n > max) throw new ProtocolError(path, `must be ${min} to ${max} code points`);
  return value;
}

function lastCounter(first: number, count: number, path: string): void {
  // Not `first + count - 1 > MAX`: past 2^53 the sum rounds, and MAX + 2 - 1 comes out as MAX.
  if (count - 1 > Number.MAX_SAFE_INTEGER - first) {
    throw new ProtocolError(path, 'the last counter is past the safe range');
  }
}

/** The number of code points in a well-formed string. */
export function codePoints(value: string): number {
  let n = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    // A high surrogate starts a pair; in a well-formed string the low half follows, so skip it.
    if (c >= 0xd800 && c <= 0xdbff) i++;
    n++;
  }
  return n;
}

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function join(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}
