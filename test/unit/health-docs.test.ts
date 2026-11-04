import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHECKS } from '../../src/health/model';

const read = (): string =>
  readFileSync(fileURLToPath(new URL('../../docs/en/health-check.md', import.meta.url)), 'utf8');

describe('the health check page', () => {
  const rows = [...read().matchAll(/^\| `([a-z]+\.[a-z-]+)`\s*\|\s*([^|]+?)\s*\|/gm)];

  it('has a row for every check, and for no check that does not exist', () => {
    const documented = rows
      .map((row) => row[1])
      .filter((id) => id !== undefined && /^(catalog|connection|storage|deep)\./.test(id));
    expect(documented.toSorted()).toEqual(Object.keys(CHECKS).toSorted());
  });

  it('names the severities of every check as the table of checks allows', () => {
    for (const [id, check] of Object.entries(CHECKS)) {
      const row = rows.find((candidate) => candidate[1] === id);
      expect(row, id).toBeDefined();
      expect(
        row?.[2]
          ?.split(',')
          .map((word) => word.trim())
          .toSorted(),
        id,
      ).toEqual([...check.severities].toSorted());
    }
  });
});
