import type { DuckDBConnection } from '@duckdb/node-api';

export function readPositionalCounts(connection: DuckDBConnection): Promise<Record<string, number>>;
export function renderDuckdbVocabulary(
  counts: Readonly<Record<string, number>>,
  duckdbVersion: string,
): Promise<string>;
export function generateDuckdbVocabulary(): Promise<string>;
