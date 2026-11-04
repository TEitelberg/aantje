import { inject } from 'vitest';
import { openPostgres } from '../../../src/catalog/drivers/postgres';
import type { CatalogSource } from './types';

export const postgresSource: CatalogSource = {
  name: 'postgres',
  skipReason: () => {
    if (inject('postgres')) {
      return undefined;
    }
    return process.env.AANTJE_POSTGRES === '1'
      ? 'Docker is not available'
      : 'set AANTJE_POSTGRES=1 to run it (needs Docker)';
  },
  open: () => {
    const fixture = inject('postgres');
    if (!fixture) {
      return Promise.reject(new Error('The Postgres fixture is not running; check skipReason() first.'));
    }
    return openPostgres(fixture);
  },
};
