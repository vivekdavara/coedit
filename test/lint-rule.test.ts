// The CRDT's rule against passing a list as arguments (eslint.config.js, packages/crdt/src), run through ESLint's
// Linter on snippets: what it must flag, what it must allow, and what no syntactic rule can see. Reviews 2 to 4 of
// day 2 each found forms the rule then missed; without this test any weakening of it passed everything.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

interface Entry {
  readonly files?: readonly string[];
  readonly rules?: Readonly<Record<string, Linter.RuleEntry>>;
}

const { default: config } = (await import(
  new URL('../eslint.config.js', import.meta.url).href
)) as {
  default: readonly Entry[];
};
const entry = config.find(
  (c) =>
    c.files?.includes('packages/crdt/src/**/*.ts') === true &&
    c.rules?.['no-restricted-syntax'] !== undefined,
);
assert.ok(entry?.rules !== undefined, "eslint.config.js has the CRDT's no-restricted-syntax block");
const rule = entry.rules['no-restricted-syntax'] as Linter.RuleEntry;

const PRELUDE = `
declare const into: number[];
declare const list: number[];
declare const fp: Record<string, (thisArg: unknown, args: number[]) => number>;
declare const k: string;
const push = Array.prototype.push;
`;

/** How many times the rule flags `code`. */
function flagged(code: string): number {
  const messages = new Linter({ configType: 'flat' }).verify(
    PRELUDE + code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        rules: { 'no-restricted-syntax': rule },
      },
    ],
    'packages/crdt/src/probe.ts',
  );
  for (const m of messages) assert.ok(m.fatal !== true, `${code}: ${m.message}`);
  return messages.filter((m) => m.ruleId === 'no-restricted-syntax').length;
}

describe("the CRDT's lint rule", () => {
  const refused: Record<string, string> = {
    'a spread into push': 'into.push(...list);',
    'a spread into a computed push': "into['push'](...list);",
    'a spread into Math.max': 'Math.max(...list);',
    'a spread into a constructor': 'new Set(...[list]);',
    'a spread into splice': 'into.splice(0, 0, ...list);',
    'push.apply': 'push.apply(into, list);',
    'Array.prototype.push.apply': 'Array.prototype.push.apply(into, list);',
    'Function.prototype.apply.call': 'Function.prototype.apply.call(push, into, list);',
    "a literal 'apply' key": "fp['apply'](push, list);",
    'a template key': 'fp[`apply`](push, list);',
    'a String.raw key': 'fp[String.raw`apply`](push, list);',
    'a concatenated key': "fp['app' + 'ly'](push, list);",
    'a key ending in a literal': "void fp[k + 'ly'];",
    'a destructured apply': 'const { apply } = Function.prototype; void apply;',
    "a destructured 'apply' key": "const { 'apply': ap } = Function.prototype; void ap;",
    'Reflect.apply': 'Reflect.apply(push, into, list);',
    'Reflect by another name': 'const R = Reflect; void R;',
    'a dotted construct': 'void fp.construct;',
    'Reflect.construct': 'Reflect.construct(Array, list);',
    'a property descriptor': "Object.getOwnPropertyDescriptor(Function.prototype, 'call');",
    'Reflect through globalThis': "void (globalThis as Record<string, unknown>)['Refl' + 'ect'];",
  };
  for (const [name, code] of Object.entries(refused)) {
    test(`flags ${name}`, () => {
      assert.ok(flagged(code) > 0, code);
    });
  }

  test('allows what the CRDT does: private methods, indexes, the one bounded spread', () => {
    const allowed = [
      'class C { #apply(x: number): number { return x; } run(): number { return this.#apply(1); } }',
      'declare const i: number; void into[i + 1]; void into[i++]; void "ab"[i];',
      '// eslint-disable-next-line no-restricted-syntax -- bounded\ninto.splice(0, 0, ...list);',
      'into.push(list.length);',
    ];
    for (const code of allowed) assert.equal(flagged(code), 0, code);
  });

  test("can't see a key held in a variable, as its comment says", () => {
    // Pinned so the limit stays documented rather than discovered: these overflow the stack too.
    assert.equal(flagged('void fp[k];'), 0);
    assert.equal(flagged('const { [k]: ap } = fp; void ap;'), 0);
  });
});
