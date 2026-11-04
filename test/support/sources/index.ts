import { duckdbSource } from './duckdb';
import { postgresSource } from './postgres';
import { quackSource } from './quack';
import { sqliteSource } from './sqlite';
import type { CatalogSource } from './types';

export type { CatalogSource } from './types';

/** All catalog sources; use with `describe.each` and honour `skipReason()`. */
export const catalogSources: readonly CatalogSource[] = [
  sqliteSource,
  duckdbSource,
  postgresSource,
  quackSource,
];
