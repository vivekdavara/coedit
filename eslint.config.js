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
    files: ['packages/client/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
    languageOptions: { globals: globals.browser },
  },
);
