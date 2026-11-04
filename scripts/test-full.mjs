// Runs the whole test suite including the Postgres tests (needs Docker and network access for the DuckDB extensions,
// a missing extension fails instead of skipping): npm run test:full [-- vitest args]
import { spawnSync } from 'node:child_process';

const result = spawnSync('npx', ['vitest', 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, AANTJE_POSTGRES: '1', AANTJE_REQUIRE_ENGINE: '1' },
});
process.exit(result.status ?? 1);
