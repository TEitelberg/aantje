import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/log';
import { openLanguageService } from '../../src/sql/language';

vi.mock('../../src/data/open-lake', () => ({
  loadEngine: () => Promise.reject(new Error('the DuckDB binding is broken')),
}));

describe('a language service whose DuckDB cannot start', () => {
  it('fails every call, answers the syntax check with no errors, and logs each kind of failure once', async () => {
    const errors: [string, unknown][] = [];
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (message, error) => void errors.push([message, error]),
    };
    const service = openLanguageService({ logger });

    for (let call = 0; call < 3; call += 1) {
      await expect(service.tokenize('SELECT 1')).rejects.toThrow('the DuckDB binding is broken');
      expect(await service.diagnose(`SELECT ${call}`, 'a')).toEqual([]);
    }

    expect(errors).toHaveLength(2);
    expect((errors[0]?.[1] as Error).message).toBe('the DuckDB binding is broken');
    await service.dispose();

    const silent = openLanguageService();
    await expect(silent.vocabulary()).rejects.toThrow('the DuckDB binding is broken');
    await silent.dispose();
  });
});
