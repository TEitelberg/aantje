import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      'dist/**',
      'docker/**',
      'out/**',
      'node_modules/**',
      '.vscode-test/**',
      'test/fixtures/**',
      'artifacts/**',
      '*.vsix',
      'test/e2e/out/**',
      'test/.cache/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Only thin adapters may touch the VS Code API; everything else stays testable without it.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message: 'Import "vscode" only in src/extension.ts and src/**/*.vscode.ts adapters.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/extension.ts', 'src/**/*.vscode.ts', 'test/integration/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // Console output would bypass the redacting logger.
    files: ['src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      eqeqeq: 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/no-deprecated': 'error',
      '@typescript-eslint/no-shadow': 'warn',
      // Size limits are advisory: a warning marks code that is hard to follow, it does not fail the build.
      complexity: ['warn', 20],
      'max-depth': ['warn', 4],
      'max-lines': ['warn', { max: 600, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 150, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // A committed `.only` would silently skip the rest of the suite.
    files: ['test/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='only']",
          message: 'Remove .only: it skips every other test.',
        },
      ],
    },
  },
  { files: ['**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly' } } },
  {
    // The end-to-end harness runs in Node (runner, supervisor, specs), but the callbacks that it hands to
    // page.evaluate run in the browser: it needs both sets of globals.
    files: ['test/e2e/**/*.mjs'],
    languageOptions: {
      globals: Object.fromEntries(
        [
          ...['AbortSignal', 'clearTimeout', 'setTimeout'],
          ...['crypto', 'document', 'fetch', 'getComputedStyle', 'navigator', 'window'],
        ].map((name) => [name, 'readonly']),
      ),
    },
    rules: {
      // Without a timeout, toPass() retries forever, even after the page was closed.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='toPass'][arguments.length=0]",
          message: 'toPass() without a timeout never ends. Use eventually() from test/e2e/lib/expect.mjs.',
        },
      ],
    },
  },
);
