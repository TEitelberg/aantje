import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateDucklakeVocabulary } from '../../scripts/ducklake-vocabulary.mjs';
import { GLOBAL_LAKE_FUNCTIONS, INTERNAL_FUNCTIONS, LAKE_TEXT_NAMES } from '../../src/sql/ducklake';
import { DUCKLAKE_FUNCTIONS } from '../../src/sql/ducklake-vocabulary';
import { engineSkipReason, extensionDirectory } from './data-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`The comparison of the DuckLake vocabulary with the engine is skipped: ${skipReason}`);
}

describe('the vocabulary of DuckLake', () => {
  it.skipIf(skipReason !== undefined)(
    'is what the DuckLake extension of the shipped DuckDB lists: run `npm run vocabulary:ducklake` when this fails',
    async () => {
      const file = readFileSync(new URL('../../src/sql/ducklake-vocabulary.ts', import.meta.url), 'utf8');
      expect(await generateDucklakeVocabulary(extensionDirectory)).toBe(file.replaceAll('\r\n', '\n'));
    },
    30_000,
  );

  it('has a text for every function of the engine except the internal ones, and none for a function it lacks', () => {
    const names = DUCKLAKE_FUNCTIONS.map(({ name }) => name);
    expect(GLOBAL_LAKE_FUNCTIONS.map(({ name }) => name)).toEqual(
      names.filter((name) => !INTERNAL_FUNCTIONS.has(name)),
    );
    expect(LAKE_TEXT_NAMES.map((name) => `ducklake_${name}`).sort()).toEqual(
      GLOBAL_LAKE_FUNCTIONS.map(({ name }) => name).sort(),
    );
    for (const name of INTERNAL_FUNCTIONS) expect(names, name).toContain(name);
  });
});
