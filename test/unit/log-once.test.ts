import { expect, it } from 'vitest';
import type { Logger } from '../../src/log';
import { failureLog } from '../../src/log-once';

it('logs the first failure of each kind with its error, drops the repeats, and does not share what it saw with another log', () => {
  const lines: [string, unknown][] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (message, error) => void lines.push([message, error]),
  };
  const failed = failureLog(logger);
  const first = new Error('parser is gone');

  failed('Completion', first);
  failed('Completion', new Error('again'));
  failed('Hover', new Error('hover broke'));
  failed('Completion', new Error('and again'));
  failureLog(logger)('Hover', new Error('a fresh log'));

  expect(lines.map(([message]) => message.startsWith('Completion'))).toEqual([true, false, false]);
  expect(lines.map(([, error]) => (error as Error).message)).toEqual([
    'parser is gone',
    'hover broke',
    'a fresh log',
  ]);
  expect(lines[0]?.[1]).toBe(first);
});
