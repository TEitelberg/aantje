import { fileURLToPath } from 'node:url';
import { inject } from 'vitest';
import { openQuack } from '../../../src/catalog/drivers/quack';
import type { Driver } from '../../../src/catalog/drivers/driver';
import type { QuackFixture } from '../quack-fixture';
import { duckdbSource } from './duckdb';
import type { CatalogSource } from './types';

// The cache of the engine tests (test/unit/data-support.ts), which installs quack once per run.
const extensionDirectory = fileURLToPath(new URL('../../.cache/duckdb-extensions', import.meta.url));

/** Why a Quack fixture cannot run here, like the Postgres one: it needs AANTJE_POSTGRES=1 and Docker. */
export function quackSkipReason(fixture: QuackFixture | null): string | undefined {
  if (fixture) {
    return duckdbSource.skipReason();
  }
  return process.env.AANTJE_POSTGRES === '1'
    ? 'Docker is not available'
    : 'set AANTJE_POSTGRES=1 to run it (needs Docker)';
}

/** The explorer driver on a fixture server over plain HTTP. */
export function openQuackFixture(fixture: QuackFixture | null): Promise<Driver> {
  if (!fixture) {
    return Promise.reject(new Error('The Quack fixture is not running; check skipReason() first.'));
  }
  return openQuack({ ...fixture, ssl: false, extensionDirectory });
}

export const quackSource: CatalogSource = {
  name: 'quack',
  skipReason: () => quackSkipReason(inject('quack')),
  open: () => openQuackFixture(inject('quack')),
};
