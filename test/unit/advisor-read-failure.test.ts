import { describe, expect, it, vi } from 'vitest';
import { readAdvisor } from '../../src/advisor/read';
import type { DataAccess } from '../../src/data/types';
import { AantjeError } from '../../src/errors';

// The dry runs of the advisor run on an engine of their own, which lists the store. The engine is replaced here by a
// stand-in that records the signal it was given.
const measure = vi.hoisted(() => ({ signals: [] as (AbortSignal | undefined)[] }));
vi.mock('../../src/advisor/measure', () => ({
  measureDryRuns: (
    _access: unknown,
    _policy: unknown,
    _snapshots: number,
    _path: unknown,
    signal?: AbortSignal,
  ) => {
    measure.signals.push(signal);
    return new Promise<never>(() => undefined);
  },
}));

const access = {
  profile: { id: 'a', name: 'a', kind: 'duckdb', path: 'x' },
  s3: {},
} as unknown as DataAccess;

function reader(failure: Error) {
  return {
    info: () => Promise.resolve({ specVersion: '1.1', latestSnapshot: 3 }),
    metadata: () => Promise.resolve([]),
    snapshotCount: () => Promise.resolve(3),
    scheduledForDeletion: () => Promise.resolve(null),
    expirableSnapshots: () => Promise.resolve(null),
    entries: () => Promise.resolve([]),
    maintenanceFacts: () => Promise.resolve({ smallFiles: [], noCompaction: [], inlined: [] }),
    deleteHeavyTables: () => Promise.reject(failure),
  } as unknown as Parameters<typeof readAdvisor>[0]['reader'];
}

describe('readAdvisor when a catalog read fails', () => {
  it('stops the dry runs that nobody waits for any more, and rejects with the error of the read', async () => {
    const timeout = new AantjeError('TIMEOUT', 'The catalog query exceeded the time limit.');
    const outer = new AbortController();

    await expect(
      readAdvisor({ reader: reader(timeout), access }, 'Lake', new Date(), outer.signal),
    ).rejects.toBe(timeout);

    expect(measure.signals).toHaveLength(1);
    expect(measure.signals[0]?.aborted).toBe(true);
    // The caller's own signal is not the one that was aborted.
    expect(outer.signal.aborted).toBe(false);
  });
});
