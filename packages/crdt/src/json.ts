/**
 * A strict JSON reader for the wire format. `JSON.parse` accepts things that would let two replicas read one
 * message differently, or read it differently from the replica that wrote it:
 *
 * - duplicate keys (it keeps the last; another reader may keep the first),
 * - lone surrogates (`"\ud800"`), which aren't text and can't be stored or sent as UTF-8,
 * - numbers it rounds: `9007199254740993` reads as `...992`, `1e400` as Infinity, `-0` as -0.
 *
 * This reader refuses all of those, and also anything the protocol never uses: fractions and exponents (every
 * number in the protocol is an integer), a byte order mark, and nesting deeper than {@link MAX_DEPTH}. Where it
 * accepts a text, it gives the same value as `JSON.parse` (a property test checks that).
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export const MAX_DEPTH = 32;

export class JsonError extends Error {
  /** The offset in the text (UTF-16 code units) where reading failed. */
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = 'JsonError';
    this.offset = offset;
  }
}

/** Reads one JSON value, with nothing but whitespace around it. Objects come back with a null prototype. */
export function parseJson(text: string): JsonValue {
  const reader = new Reader(text);
  reader.skipWhitespace();
  const value = reader.value(0);
  reader.skipWhitespace();
  if (reader.pos < text.length) reader.fail('unexpected text after the value');
  return value;
}

const INTEGER = /-?(0|[1-9][0-9]*)/y;

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

class Reader {
  readonly text: string;
  pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  fail(message: string, at: number = this.pos): never {
    throw new JsonError(message, at);
  }

  skipWhitespace(): void {
    const { text } = this;
    while (this.pos < text.length) {
      const c = text.charCodeAt(this.pos);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      this.pos++;
    }
  }

  value(depth: number): JsonValue {
    const c = this.text[this.pos];
    switch (c) {
      case '{':
        return this.object(depth + 1);
      case '[':
        return this.array(depth + 1);
      case '"':
        return this.string();
      case 't':
        return this.literal('true', true);
      case 'f':
        return this.literal('false', false);
      case 'n':
        return this.literal('null', null);
      case undefined:
        return this.fail('unexpected end of text');
      default:
        if (c === '-' || (c >= '0' && c <= '9')) return this.number();
        if (c === '﻿') return this.fail('byte order mark');
        return this.fail(`unexpected character ${JSON.stringify(c)}`);
    }
  }

  literal<T>(word: string, value: T): T {
    if (!this.text.startsWith(word, this.pos)) this.fail(`expected ${word}`);
    this.pos += word.length;
    return value;
  }

  object(depth: number): JsonObject {
    if (depth > MAX_DEPTH) this.fail(`nested deeper than ${MAX_DEPTH}`);
    this.pos++; // {
    const result = Object.create(null) as JsonObject;
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.pos] === '}') {
      this.pos++;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      const keyAt = this.pos;
      if (this.text[this.pos] !== '"') this.fail('expected a string key');
      const key = this.string();
      if (seen.has(key)) this.fail(`duplicate key ${JSON.stringify(key)}`, keyAt);
      seen.add(key);
      this.skipWhitespace();
      if (this.text[this.pos] !== ':') this.fail("expected ':'");
      this.pos++;
      this.skipWhitespace();
      result[key] = this.value(depth);
      this.skipWhitespace();
      const next = this.text[this.pos];
      if (next === ',') {
        this.pos++;
      } else if (next === '}') {
        this.pos++;
        return result;
      } else {
        this.fail("expected ',' or '}'");
      }
    }
  }

  array(depth: number): JsonValue[] {
    if (depth > MAX_DEPTH) this.fail(`nested deeper than ${MAX_DEPTH}`);
    this.pos++; // [
    const result: JsonValue[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === ']') {
      this.pos++;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      result.push(this.value(depth));
      this.skipWhitespace();
      const next = this.text[this.pos];
      if (next === ',') {
        this.pos++;
      } else if (next === ']') {
        this.pos++;
        return result;
      } else {
        this.fail("expected ',' or ']'");
      }
    }
  }

  string(): string {
    const { text } = this;
    const start = this.pos;
    this.pos++; // "
    let result = '';
    let chunk = this.pos;
    for (;;) {
      if (this.pos >= text.length) this.fail('unterminated string', start);
      const c = text.charCodeAt(this.pos);
      if (c === 0x22) {
        result += text.slice(chunk, this.pos);
        this.pos++;
        break;
      }
      if (c < 0x20) this.fail('control character in a string (it must be escaped)');
      if (c !== 0x5c) {
        this.pos++;
        continue;
      }
      result += text.slice(chunk, this.pos);
      const escape = text[this.pos + 1];
      if (escape === 'u') {
        const hex = text.slice(this.pos + 2, this.pos + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('bad \\u escape');
        result += String.fromCharCode(parseInt(hex, 16));
        this.pos += 6;
      } else {
        const decoded = escape === undefined ? undefined : ESCAPES[escape];
        if (decoded === undefined) this.fail('bad escape');
        result += decoded;
        this.pos += 2;
      }
      chunk = this.pos;
    }
    // Checked on the result, so a surrogate pair written as two escapes is fine and half of one is not, whether
    // the half came escaped or raw.
    if (!result.isWellFormed()) this.fail('lone surrogate in a string', start);
    return result;
  }

  number(): number {
    const start = this.pos;
    INTEGER.lastIndex = start;
    const match = INTEGER.exec(this.text);
    if (match === null) return this.fail('bad number');
    const literal = match[0];
    this.pos += literal.length;
    const next = this.text[this.pos];
    if (next === '.' || next === 'e' || next === 'E') {
      this.fail('fractions and exponents are not used (integers only)', start);
    }
    if (next !== undefined && next >= '0' && next <= '9')
      this.fail('bad number (leading zero)', start);
    if (literal === '-0') this.fail('negative zero', start);
    const value = Number(literal);
    if (!Number.isSafeInteger(value))
      this.fail('integer outside the safe range (|n| < 2^53)', start);
    return value;
  }
}
