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
    // (runs waiting on one element, review 1 of day 2), so its sources may not spread into a call or pass a list
    // through apply (review 2 listed the ways round the first rule: a['push'](...b), push.apply, Reflect.apply,
    // Math.max(...b)). A spread whose length is bounded says so in an eslint-disable comment.
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
            "CallExpression[callee.property.name='apply'][callee.object.type='MemberExpression'], CallExpression[callee.object.name='Reflect'][callee.property.name='apply']",
          message: 'apply passes a list as arguments, which can overflow the stack; loop instead.',
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
