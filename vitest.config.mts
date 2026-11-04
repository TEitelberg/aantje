import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts', 'test/contract/**/*.test.ts'],
    // Install the DuckDB extensions once, then start the throw-away Postgres fixture (skipped without Docker).
    globalSetup: ['test/support/extensions-setup.ts', 'test/support/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // The default also lists package.json, so `vitest --changed` (the tests of a pull request) would run everything for
    // a new menu entry. The tests that read the manifest import it or run in CI anyway; a new dependency changes the
    // lock file, for which CI runs everything.
    forceRerunTriggers: ['**/{vitest,vite}.config.*'],
  },
});
