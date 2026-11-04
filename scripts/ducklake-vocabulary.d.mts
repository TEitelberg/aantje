import type { DuckDBConnection } from '@duckdb/node-api';
import type { GeneratedFunction } from '../src/sql/ducklake';

export function readDucklakeFunctions(connection: DuckDBConnection): Promise<GeneratedFunction[]>;
export function renderDucklakeVocabulary(
  functions: readonly GeneratedFunction[],
  duckdbVersion: string,
): Promise<string>;
export function generateDucklakeVocabulary(extensionDirectory?: string): Promise<string>;
