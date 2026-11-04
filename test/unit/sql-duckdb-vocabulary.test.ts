import { readFileSync } from 'node:fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { describe, expect, it } from 'vitest';
import { generateDuckdbVocabulary } from '../../scripts/duckdb-vocabulary.mjs';
import { COPY_FORMATS, COPY_TO_ANY_FORMAT, COPY_TO_OPTIONS } from '../../src/sql/duckdb';

describe('the vocabulary of DuckDB', () => {
  it('says where the named parameters of the table functions start, as the shipped DuckDB binds them: run `node scripts/duckdb-vocabulary.mjs` when this fails', async () => {
    const file = readFileSync(new URL('../../src/sql/duckdb-vocabulary.ts', import.meta.url), 'utf8');
    expect(await generateDuckdbVocabulary()).toBe(file.replaceAll('\r\n', '\n'));
  }, 30_000);

  it('offers only options of COPY ... TO that the shipped DuckDB accepts for their format', async () => {
    // External access is off, as in the language service: the options are bound, and no file is written.
    const instance = await DuckDBInstance.create(':memory:', { enable_external_access: 'false' });
    const connection = await instance.connect();
    const refusal = (format: string, option: string): Promise<string | undefined> =>
      connection.run(`EXPLAIN COPY (SELECT 1 AS a) TO 'out.${format}' (FORMAT ${format}, ${option})`).then(
        () => undefined,
        (error: unknown) => /Unrecognized option|Unknown option/.exec(String(error))?.[0],
      );
    try {
      expect(await refusal('csv', 'no_such_option')).toBeDefined();
      const refused: string[] = [];
      for (const format of COPY_FORMATS) {
        for (const option of [...(COPY_TO_OPTIONS[format] ?? []), ...COPY_TO_ANY_FORMAT]) {
          if (option !== 'format' && (await refusal(format, option))) refused.push(`${format}: ${option}`);
        }
      }
      expect(refused).toEqual([]);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });
});
