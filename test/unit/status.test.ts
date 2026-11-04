import { describe, expect, it } from 'vitest';
import { activeProfile, statusBarContent, type StatusBarState } from '../../src/status';
import type { ConnectionState } from '../../src/tree/refs';
import { LATEST_SNAPSHOT, SNAPSHOT, SPEC_VERSION } from '../support/expected';

const connected: StatusBarState = {
  connectionName: 'example',
  status: 'connected',
  specVersion: SPEC_VERSION,
  snapshot: 'latest',
  latestSnapshot: LATEST_SNAPSHOT,
};

describe('statusBarContent for a connected catalog', () => {
  it('names the connection, the DuckLake version and the snapshot that is followed, and offers to select a snapshot', () => {
    const { text, tooltip } = statusBarContent(connected);

    expect(text).toContain('example');
    expect(text).toContain(SPEC_VERSION);
    expect(text).toContain(`@${LATEST_SNAPSHOT}`);
    expect(text).not.toContain('pinned');
    expect(tooltip).toContain('Select snapshot');
  });

  it('marks a selected snapshot as pinned, also when it is the newest one or snapshot 0', () => {
    for (const snapshot of [SNAPSHOT.deleteOrder2, LATEST_SNAPSHOT, SNAPSHOT.createMainSchema]) {
      const { text, tooltip } = statusBarContent({ ...connected, snapshot });
      expect(text, String(snapshot)).toContain(`@${snapshot} (pinned)`);
      expect(tooltip, String(snapshot)).toContain(`@${snapshot}`);
    }
    // Snapshot 0 is the only snapshot of a new catalog and the oldest one of every catalog.
    expect(statusBarContent({ ...connected, latestSnapshot: 0 }).text).toMatch(/latest \(@0\)/);
    expect(statusBarContent({ ...connected, snapshot: 0, latestSnapshot: 0 }).text).toContain('@0 (pinned)');
  });

  it('leaves out what is not known yet', () => {
    expect(statusBarContent({ ...connected, latestSnapshot: undefined }).text).toMatch(/latest$/);
    expect(statusBarContent({ ...connected, latestSnapshot: undefined }).tooltip).not.toContain('@');
    expect(statusBarContent({ ...connected, specVersion: undefined }).text).not.toContain(SPEC_VERSION);
    expect(statusBarContent({ ...connected, snapshot: 6, latestSnapshot: undefined }).text).toContain(
      '@6 (pinned)',
    );
  });
});

describe('statusBarContent while the catalog cannot be browsed', () => {
  it('shows the status instead of the snapshot, whatever snapshot was selected, and does not offer to select one', () => {
    for (const status of ['connecting', 'disconnected', 'error'] as const) {
      const contents = (['latest', SNAPSHOT.deleteOrder2] as const).map((snapshot) =>
        statusBarContent({ ...connected, status, snapshot }),
      );
      expect(contents[0], status).toEqual(contents[1]);
      expect(contents[0]?.text, status).toContain('example');
      expect(contents[0]?.text, status).not.toContain('@');
      expect(contents[0]?.text, status).not.toContain(SPEC_VERSION);
      expect(contents[0]?.tooltip, status).not.toContain('Select snapshot');
    }
    const texts = (['connecting', 'disconnected', 'error'] as const).map(
      (status) => statusBarContent({ ...connected, status }).text,
    );
    expect(new Set(texts).size).toBe(3);
  });
});

describe('activeProfile', () => {
  const profiles = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const statuses: Record<string, ConnectionState['status']> = {
    a: 'disconnected',
    b: 'connected',
    c: 'connecting',
  };
  const statusOf = (profile: { id: string }) => statuses[profile.id] ?? 'disconnected';

  it('keeps the connection in use while it is not disconnected, else moves to the first connected one, else the first', () => {
    expect(activeProfile(profiles, 'c', statusOf)).toEqual({ id: 'c' });
    expect(activeProfile(profiles, 'a', statusOf)).toEqual({ id: 'b' });
    expect(activeProfile(profiles, 'gone', statusOf)).toEqual({ id: 'b' });
    expect(activeProfile(profiles, undefined, () => 'disconnected')).toEqual({ id: 'a' });
    expect(activeProfile([], 'a', statusOf)).toBeUndefined();
  });
});
