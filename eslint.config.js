import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/', '**/dist/', 'coverage/', 'data/', '.scratch/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // node:test's describe() and test() return promises the runner itself awaits.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['describe', 'test', 'it', 'suite'] },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    // The CRDT runs in the browser and in Node, and the client only in the browser: their sources may not
    // import Node's modules (tests may).
    files: ['packages/crdt/src/**/*.ts', 'packages/client/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: '^node:', message: 'This code also runs in the browser.' }] },
      ],
    },
  },
  {
    // A list passed as arguments goes on the stack: about 110,000 overflow it. The CRDT holds lists of any length
    // (runs waiting on one element, review 1 of day 2), so its sources may not spread into a call, nor touch
    // Function.prototype.apply or Reflect at all (reviews 2 and 3 listed the ways round narrower rules:
    // a['push'](...b), push.apply, Function.prototype.apply.call, Reflect.construct, a destructured apply). The
    // property names apply and construct are refused wherever they're read, which also refuses calling another
    // object's Rga.apply from here (this.#apply is a private name, so it's allowed); a spread whose length is
    // bounded says so in an eslint-disable comment.
    files: ['packages/crdt/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression > SpreadElement, NewExpression > SpreadElement',
          message:
            'A list of unbounded length spread into a call can overflow the stack; loop instead.',
        },
        {
          selector:
            "MemberExpression[property.type='Identifier'][property.name=/^(apply|construct)$/], MemberExpression[computed=true][property.value=/^(apply|construct)$/], Identifier[name='Reflect']",
          message:
            'apply and Reflect pass a list as arguments, which can overflow the stack; loop instead.',
        },
      ],
    },
  },
  {
    files: ['packages/client/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
    languageOptions: { globals: globals.browser },
  },
);
