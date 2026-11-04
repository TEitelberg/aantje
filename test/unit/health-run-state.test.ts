import { describe, expect, it } from 'vitest';
import type { HealthEvent } from '../../src/health/model';
import { createRunState } from '../../src/health/run-state';
import { sampleFinding } from './health-report-support';

describe('the state of one health run', () => {
  it('reports every change of a group and every finding in the order they happen', () => {
    const events: HealthEvent[] = [];
    const state = createRunState((event) => events.push(event));
    const stray = sampleFinding('storage.file-orphaned', 'info', { kind: 'lake' }, { object: 'a' });

    state.setGroup({ group: 'catalog', state: 'running' });
    state.add([stray]);
    state.setGroup({ group: 'catalog', state: 'done' });

    expect(events).toEqual([
      { type: 'group', status: { group: 'catalog', state: 'running' } },
      { type: 'finding', finding: stray },
      { type: 'group', status: { group: 'catalog', state: 'done' } },
    ]);
    expect(state.findings).toEqual([stray]);
    expect(state.has('storage.file-orphaned')).toBe(true);
    expect(state.has('storage.file-missing')).toBe(false);
  });

  it('skips only the groups that did not finish, and a running one counts as unfinished', () => {
    const state = createRunState(undefined);
    state.setGroup({ group: 'catalog', state: 'done' });
    state.setGroup({ group: 'connection', state: 'failed', message: 'down' });
    state.setGroup({ group: 'storage', state: 'running' });

    state.skipUnfinished('Cancelled.');

    expect([...state.statuses.values()]).toEqual([
      { group: 'catalog', state: 'done' },
      { group: 'connection', state: 'failed', message: 'down' },
      { group: 'storage', state: 'skipped', reason: 'Cancelled.' },
      { group: 'deep', state: 'skipped', reason: 'Cancelled.' },
    ]);
  });

  it('reports nothing after it is closed, but still records the findings', () => {
    const events: HealthEvent[] = [];
    const state = createRunState((event) => events.push(event));
    state.close();

    state.setGroup({ group: 'deep', state: 'running' });
    state.add([sampleFinding('storage.file-orphaned', 'info', { kind: 'lake' }, { object: 'a' })]);

    expect(events).toEqual([]);
    expect(state.findings).toHaveLength(1);
  });
});
