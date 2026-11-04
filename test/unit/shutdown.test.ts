import { describe, expect, it } from 'vitest';
import type { Logger } from '../../src/log';
import { disposeAll } from '../../src/shutdown';

function recordingLogger() {
  const lines: string[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: (message) => void lines.push(`info ${message}`),
    warn: (message) => void lines.push(`warn ${message}`),
    error: (message, error) => void lines.push(`error ${message} ${String(error)}`),
  };
  return { lines, logger };
}

describe('disposeAll', () => {
  it('runs every disposal, logs nothing when all succeed, and returns at once whatever the deadline', async () => {
    const { lines, logger } = recordingLogger();
    const closed: string[] = [];
    const started = Date.now();

    await disposeAll(
      {
        editors: () => Promise.resolve(void closed.push('editors')),
        language: () => void closed.push('language'),
        tree: () => Promise.resolve(void closed.push('tree')),
      },
      logger,
      60_000,
    );

    expect(closed.toSorted()).toEqual(['editors', 'language', 'tree']);
    expect(lines).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does not wait for a disposal that never finishes: warns, naming it, and still runs the others', async () => {
    const { lines, logger } = recordingLogger();
    const closed: string[] = [];
    const started = Date.now();

    await disposeAll(
      {
        editors: () => new Promise<void>(() => undefined),
        language: () => Promise.resolve(void closed.push('language')),
        tree: () => Promise.resolve(void closed.push('tree')),
      },
      logger,
      50,
    );

    expect(Date.now() - started).toBeLessThan(2000);
    expect(closed.toSorted()).toEqual(['language', 'tree']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^warn .*editors/);
  });

  it('logs a disposal that fails or throws, naming it and the error, and still closes the others', async () => {
    const { lines, logger } = recordingLogger();
    const closed: string[] = [];

    await disposeAll(
      {
        editors: () => Promise.reject(new Error('locked')),
        language: () => {
          throw new Error('thrown at once');
        },
        tree: () => Promise.resolve(void closed.push('tree')),
      },
      logger,
    );

    expect(closed).toEqual(['tree']);
    expect(lines.toSorted()).toEqual([
      expect.stringMatching(/^error .*editors.* Error: locked$/),
      expect.stringMatching(/^error .*language.* Error: thrown at once$/),
    ]);
  });
});
