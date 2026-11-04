import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { CatalogReader } from '../../src/catalog/model';
import type { ConnectionProfile, FileProfile } from '../../src/connections/profile';
import {
  catalogCache,
  changesCatalog,
  holdsFileExclusively,
  queryMenuItems,
  QueryEditors,
  queryStatusContent,
  scriptToRun,
  statementAt,
} from '../../src/sql/editor';
import type { EditorRef, ExplorerPort, QueryUi } from '../../src/sql/editor';
import { openLanguageService } from '../../src/sql/language';
import { MAX_RESULT_CELLS } from '../../src/sql/results';
import type { ResultsTarget, ResultsView, RunSummary } from '../../src/sql/results';
import { openSqlSession } from '../../src/sql/session';
import type { SessionMode, SqlEvent, SqlSession } from '../../src/sql/session';
import { accessFor, copyDataFixture, engineSkipReason } from './data-support';
import type { DataFixture } from './data-support';
import { events, only, openReader } from './sql-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`SQL editor tests are skipped: ${skipReason}`);
}

const LONG_QUERY = 'SELECT count(*) FROM range(100000000000)';

type Call =
  | { call: 'begin'; target: ResultsTarget; text: string; startedAt: number }
  | { call: 'event'; target: ResultsTarget; event: SqlEvent }
  | { call: 'end'; target: ResultsTarget; summary: RunSummary }
  | { call: 'reveal'; target: ResultsTarget };

class FakeResults implements ResultsView {
  readonly calls: Call[] = [];
  /** How many more calls of each method throw, like a results panel that is broken. */
  readonly failing = { begin: 0, event: 0, end: 0, reveal: 0 };

  private check(method: keyof FakeResults['failing']): void {
    if (this.failing[method] > 0) {
      this.failing[method]--;
      throw new Error(`the results view cannot ${method}`);
    }
  }

  begin(target: ResultsTarget, script: { text: string; startedAt: number }): void {
    this.check('begin');
    this.calls.push({ call: 'begin', target, ...script });
  }

  event(target: ResultsTarget, event: SqlEvent): void {
    this.check('event');
    this.calls.push({ call: 'event', target, event });
  }

  end(target: ResultsTarget, summary: RunSummary): void {
    this.check('end');
    this.calls.push({ call: 'end', target, summary });
  }

  reveal(target: ResultsTarget): void {
    this.check('reveal');
    this.calls.push({ call: 'reveal', target });
  }

  /** The order of the calls, with the kind of each event. */
  get order(): string[] {
    return this.calls.map((c) => (c.call === 'event' ? `event:${c.event.kind}` : c.call));
  }

  get events(): SqlEvent[] {
    return this.calls.flatMap((c) => (c.call === 'event' ? [c.event] : []));
  }

  get ends(): RunSummary[] {
    return this.calls.flatMap((c) => (c.call === 'end' ? [c.summary] : []));
  }

  async waitForEvent(kind: SqlEvent['kind'], count = 1): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (this.events.filter((event) => event.kind === kind).length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no ${kind} event arrived`);
  }
}

class FakeExplorer implements ExplorerPort {
  readonly log: string[] = [];
  statuses = new Map<string, ReturnType<ExplorerPort['status']>>();

  status(connectionId: string): ReturnType<ExplorerPort['status']> {
    return this.statuses.get(connectionId) ?? 'disconnected';
  }

  disconnect(connectionId: string): Promise<void> {
    this.log.push(`disconnect ${connectionId}`);
    this.statuses.set(connectionId, 'disconnected');
    return Promise.resolve();
  }

  connect(connectionId: string): void {
    this.log.push(`connect ${connectionId}`);
    this.statuses.set(connectionId, 'connected');
  }

  refresh(connectionId: string): void {
    this.log.push(`refresh ${connectionId}`);
  }
}

class FakeUi implements QueryUi {
  readonly infos: string[] = [];
  readonly picks: (readonly ConnectionProfile[])[] = [];
  readonly titles: string[] = [];
  answer: string | undefined;
  /** The Cancel button was pressed before the task got to run. */
  cancelledAtOnce = false;
  /** Cancels the progress notification that is shown now, like the user pressing Cancel. */
  cancelProgress: (() => void) | undefined;

  info(message: string): void {
    this.infos.push(message);
  }

  pickConnection(profiles: readonly ConnectionProfile[]): Promise<string | undefined> {
    this.picks.push(profiles);
    return Promise.resolve(this.answer);
  }

  async withProgress<T>(title: string, task: (cancel: AbortSignal) => Promise<T>): Promise<T> {
    this.titles.push(title);
    const control = new AbortController();
    if (this.cancelledAtOnce) control.abort();
    this.cancelProgress = () => control.abort();
    try {
      return await task(control.signal);
    } finally {
      this.cancelProgress = undefined;
    }
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const DOC: EditorRef = { key: 'untitled:Untitled-1', name: 'Untitled-1' };

interface Setup {
  readonly fixture: DataFixture;
  readonly editors: QueryEditors;
  readonly results: FakeResults;
  readonly explorer: FakeExplorer;
  readonly ui: FakeUi;
  readonly profile: FileProfile;
  /** The sessions the editors opened, with the mode each was opened in. */
  readonly opened: { session: SqlSession; mode: SessionMode }[];
  profiles: FileProfile[];
  maxRows: number;
  /** The clock of the editors; the real one while undefined. */
  now: (() => number) | undefined;
}

async function setup(kind: 'sqlite' | 'duckdb', extra: { readOnly?: boolean } = {}): Promise<Setup> {
  const fixture = await copyDataFixture(kind);
  const profile: FileProfile = { ...fixture.profile, ...extra };
  const results = new FakeResults();
  const explorer = new FakeExplorer();
  const ui = new FakeUi();
  const state: Setup = {
    fixture,
    results,
    explorer,
    ui,
    profile,
    opened: [],
    profiles: [profile],
    maxRows: 10_000,
    now: undefined,
    editors: undefined as unknown as QueryEditors,
  };
  const editors = new QueryEditors({
    profiles: {
      list: () => state.profiles,
      get: (id) => state.profiles.find((p) => p.id === id),
    },
    openSession: async (opening, mode, signal) => {
      const session = await openSqlSession({
        access: accessFor(fixture, { profile: opening }),
        mode,
        signal,
      });
      state.opened.push({ session, mode });
      return session;
    },
    results,
    explorer,
    ui,
    maxRows: () => state.maxRows,
    now: () => (state.now ?? Date.now)(),
  });
  cleanups.push(async () => {
    await editors.dispose();
    await Promise.all(state.opened.map(({ session }) => session.close()));
    await fixture.remove();
  });
  return Object.assign(state, { editors });
}

async function scalar(fixtureSession: SqlSession, sql: string): Promise<unknown> {
  const found = (await events(fixtureSession, sql)).find((event) => event.kind === 'resultSet');
  return found?.kind === 'resultSet' ? found.rows[0]?.[0] : undefined;
}

const OTHER_DOC: EditorRef = { key: 'untitled:Untitled-2', name: 'Untitled-2' };

describe.skipIf(skipReason)('the SQL editors', () => {
  describe('the session of a document', () => {
    it('opens at the first run only, in the mode of the profile, and switches the mode of one editor only', async () => {
      const s = await setup('sqlite');
      const other = OTHER_DOC;
      await s.editors.associate(DOC, s.profile.id);
      await s.editors.associate(other, s.profile.id);
      expect(s.opened).toHaveLength(0);
      expect(s.editors.state(DOC.key)).toMatchObject({ sessionOpen: false, mode: 'read-write' });

      await s.editors.run(DOC, { text: 'SELECT 1', base: 0 });
      await s.editors.run(DOC, { text: 'SELECT 2', base: 0 });
      await s.editors.run(other, { text: 'SELECT 1', base: 0 });
      expect(s.opened.map(({ mode }) => mode)).toEqual(['read-write', 'read-write']);

      await s.editors.toggleMode(DOC.key);
      expect(s.editors.state(DOC.key)).toMatchObject({ mode: 'read-only', sessionOpen: false });
      expect(s.editors.state(other.key)).toMatchObject({ mode: 'read-write', sessionOpen: true });
      await s.editors.run(DOC, { text: 'DELETE FROM sales.orders', base: 0 });
      expect(s.results.events.at(-1)).toMatchObject({ kind: 'error' });

      await s.editors.toggleMode(DOC.key);
      await s.editors.run(DOC, { text: 'SELECT 1', base: 0 });
      expect(s.opened.map(({ mode }) => mode)).toEqual([
        'read-write',
        'read-write',
        'read-only',
        'read-write',
      ]);
      expect(s.profile.readOnly).toBeUndefined();
    });

    it('opens a read-only session for a profile with readOnly and refuses a write', async () => {
      const s = await setup('sqlite', { readOnly: true });
      await s.editors.associate(DOC, s.profile.id);

      await s.editors.run(DOC, { text: 'INSERT INTO sales.orders (id) VALUES (9)', base: 0 });

      expect(s.opened.map(({ mode }) => mode)).toEqual(['read-only']);
      expect(s.editors.state(DOC.key)?.mode).toBe('read-only');
      expect(s.results.events.at(-1)).toMatchObject({ kind: 'error' });
      expect(s.results.ends).toMatchObject([{ failed: true, cancelled: false }]);
    });

    it('writes through a writable session, which the Explorer then sees as a new snapshot', async () => {
      const s = await setup('sqlite');
      await s.editors.associate(DOC, s.profile.id);

      await s.editors.run(DOC, { text: 'INSERT INTO sales.orders (id) VALUES (9)', base: 0 });

      expect(s.results.events.at(-1)).toMatchObject({ kind: 'message' });
      const reader = await openReader(s.fixture);
      cleanups.push(() => reader.close());
      expect((await reader.snapshots())[0]?.id).toBe(14);
    });

    it('closes the session and forgets the document when the document closes', async () => {
      const s = await setup('sqlite');
      await s.editors.associate(DOC, s.profile.id);
      await s.editors.run(DOC, { text: 'SELECT 1', base: 0 });
      const first = s.opened[0]?.session;

      await s.editors.documentClosed(DOC.key);

      expect(s.editors.connectionOf(DOC.key)).toBeUndefined();
      await expect(events(first as SqlSession, 'SELECT 1')).rejects.toThrow('closed');
      // A document with the same key that opens again starts fresh.
      await s.editors.associate(DOC, s.profile.id);
      await s.editors.run(DOC, { text: 'SELECT 1', base: 0 });
      expect(s.opened).toHaveLength(2);
    });

    it('rolls back an open or aborted transaction on close and on a mode switch, and names the editor', async () => {
      const s = await setup('sqlite');
      await s.editors.associate(DOC, s.profile.id);
      await s.editors.run(DOC, { text: 'BEGIN; INSERT INTO sales.orders (id) VALUES (9)', base: 0 });
      expect(s.editors.state(DOC.key)?.inTransaction).toBe('open');
      expect(s.ui.infos).toEqual([]);

      // The name of the document at the time of the close is the one that the message gives.
      await s.editors.associate({ key: DOC.key, name: 'saved.sql' }, s.profile.id);
      await s.editors.documentClosed(DOC.key);

      expect(s.ui.infos).toHaveLength(1);
      expect(s.ui.infos[0]).toContain('saved.sql');
      const check = await openSqlSession({ access: accessFor(s.fixture), mode: 'read-only' });
      cleanups.push(() => check.close());
      expect(await scalar(check, 'SELECT count(*)::INTEGER FROM sales.orders')).toBe(2);

      const aborted = await setup('sqlite');
      await aborted.editors.associate(DOC, aborted.profile.id);
      await aborted.editors.run(DOC, { text: "BEGIN; SELECT CAST('x' AS INTEGER)", base: 0 });
      expect(aborted.editors.state(DOC.key)?.inTransaction).toBe('aborted');
      await aborted.editors.documentClosed(DOC.key);
      expect(aborted.ui.infos).toHaveLength(1);

      const toggled = await setup('sqlite');
      await toggled.editors.associate(DOC, toggled.profile.id);
      await toggled.editors.run(DOC, { text: 'SELECT 1', base: 0 });
      await toggled.editors.toggleMode(DOC.key);
      expect(toggled.ui.infos).toEqual([]);
      await toggled.editors.toggleMode(DOC.key);
      await toggled.editors.run(DOC, { text: 'BEGIN', base: 0 });
      await toggled.editors.toggleMode(DOC.key);
      expect(toggled.ui.infos).toHaveLength(1);
    });

    it('closes the session of a connection that is removed or edited, keeps the others, and reopens after an edit', async () => {
      const s = await setup('sqlite');
      const twin: FileProfile = { ...s.profile, id: 'twin', name: 'Twin' };
      s.profiles = [s.profile, twin];
      const other = OTHER_DOC;
      await s.editors.associate(DOC, s.profile.id);
      await s.editors.associate(other, twin.id);
      await s.editors.run(DOC, { text: 'SELECT 1', base: 0 });
      await s.editors.run(other, { text: 'SELECT 1', base: 0 });
      await s.editors.toggleMode(other.key);

      // Renaming changes nothing; editing the mode of the profile drops the choice made in the editor.
      s.profiles = [
        { ...s.profile, name: 'Renamed' },
        { ...twin, readOnly: true },
      ];
      await s.editors.profilesChanged();
      expect(s.editors.state(DOC.key)).toMatchObject({ connectionName: 'Renamed', sessionOpen: true });
      expect(s.editors.state(other.key)).toMatchObject({ sessionOpen: false, mode: 'read-only' });
      await s.editors.run(other, { text: 'SELECT 1', base: 0 });
      expect(s.opened.at(-1)?.mode).toBe('read-only');

      s.profiles = [{ ...s.profile, name: 'Renamed' }];
      await s.editors.profilesChanged();
      expect(s.editors.connectionOf(other.key)).toBeUndefined();
      expect(s.editors.connectionOf(DOC.key)).toBe(s.profile.id);
      expect(s.editors.state(DOC.key)?.sessionOpen).toBe(true);
    });

    it('closes the session on a new connection, on Close Session and on dispose, and keeps the association where it stays', async () => {
      const s = await setup('sqlite');
      const twin: FileProfile = { ...s.profile, id: 'twin', name: 'Twin' };
      s.profiles = [s.profile, twin];
      await s.editors.associate(DOC, s.profile.id);
      await s.editors.run(DOC, { text: 'SELECT 1', base: 0 });

      await s.editors.associate(DOC, twin.id);
      expect(s.editors.state(DOC.key)).toMatchObject({ connectionName: 'Twin', sessionOpen: false });
      await expect(events(s.opened[0]?.session as SqlSession, 'SELECT 1')).rejects.toThrow('closed');

      await s.editors.run(DOC, { text: 'SELECT 1', base: 0 });
      await s.editors.closeSessionOf(DOC.key);
      expect(s.editors.state(DOC.key)).toMatchObject({ sessionOpen: false, connectionName: 'Twin' });
      await expect(events(s.opened[1]?.session as SqlSession, 'SELECT 1')).rejects.toThrow('closed');
      await s.editors.run(DOC, { text: 'SELECT 1', base: 0 });
      expect(s.opened).toHaveLength(3);

      const changes: string[] = [];
      s.editors.onDidChange(({ key }) => changes.push(key));
      await s.editors.dispose();
      await expect(events(s.opened[2]?.session as SqlSession, 'SELECT 1')).rejects.toThrow('closed');
      await s.editors.associate(DOC, s.profile.id);
      expect(changes).toEqual([]);
    });

    it('tells the listeners which editor changed, and whether its connection did', async () => {
      const s = await setup('sqlite');
      const twin: FileProfile = { ...s.profile, id: 'twin', name: 'Twin' };
      s.profiles = [s.profile, twin];
      const changes: string[] = [];
      s.editors.onDidChange(({ key, association }) => changes.push(`${key.slice(-1)}:${association}`));
      const other = OTHER_DOC;
      const next = async (action: () => Promise<unknown>): Promise<string[]> => {
        changes.length = 0;
        await action();
        return [...new Set(changes)];
      };

      expect(await next(() => s.editors.associate(DOC, s.profile.id))).toEqual(['1:true']);
      expect(await next(() => s.editors.associate(DOC, s.profile.id))).toEqual([]);
      expect(await next(() => s.editors.run(DOC, { text: 'SELECT 1', base: 0 }))).toEqual(['1:false']);
      expect(await next(() => s.editors.toggleMode(DOC.key))).toEqual(['1:false']);
      expect(await next(() => s.editors.closeSessionOf(DOC.key))).toEqual(['1:false']);
      expect(await next(() => s.editors.associate(DOC, twin.id))).toEqual(['1:true']);
      await s.editors.associate(other, s.profile.id);
      s.profiles = [s.profile, { ...twin, readOnly: true }];
      expect(await next(() => s.editors.profilesChanged())).toEqual(['1:false']);
      s.profiles = [{ ...s.profile }];
      expect(await next(() => s.editors.profilesChanged())).toEqual(['1:true']);
      expect(await next(() => s.editors.documentClosed(other.key))).toEqual(['2:true']);
      expect(await next(() => s.editors.documentClosed('unknown'))).toEqual([]);
    });

    it('refuses to change the connection or the mode while a query runs, and does not touch the run', async () => {
      const s = await setup('sqlite');
      const twin: FileProfile = { ...s.profile, id: 'twin', name: 'Twin' };
      s.profiles = [s.profile, twin];
      await s.editors.associate(DOC, s.profile.id);
      const running = s.editors.run(DOC, { text: LONG_QUERY, base: 0 });
      await s.results.waitForEvent('start');

      await s.editors.associate(DOC, twin.id);
      await s.editors.toggleMode(DOC.key);

      expect(s.ui.infos).toHaveLength(2);
      expect(s.editors.connectionOf(DOC.key)).toBe(s.profile.id);
      expect(s.editors.state(DOC.key)).toMatchObject({
        running: true,
        mode: 'read-write',
        sessionOpen: true,
      });
      expect(s.results.ends).toEqual([]);
      s.editors.cancel(DOC.key);
      expect(await running).toMatchObject({ cancelled: true });
    });
  });

  describe('a run', () => {
    it('shows progress once and hands every event to the results in order, with the summary', async () => {
      const s = await setup('sqlite');
      await s.editors.associate(DOC, s.profile.id);

      const summary = await s.editors.run(DOC, {
        text: 'SELECT id FROM sales.orders ORDER BY id; UPDATE sales.orders SET id = id',
        base: 0,
      });

      expect(s.ui.titles).toHaveLength(1);
      expect(s.results.order).toEqual([
        'begin',
        'reveal',
        'event:start',
        'event:resultSet',
        'event:start',
        'event:message',
        'end',
      ]);
      expect(new Set(s.results.calls.map((c) => c.target.key))).toEqual(new Set([DOC.key]));
      expect(s.results.calls[0]).toMatchObject({
        call: 'begin',
        text: 'SELECT id FROM sales.orders ORDER BY id; UPDATE sales.orders SET id = id',
      });
      expect(s.results.events[1]).toMatchObject({ kind: 'resultSet', rows: [[1], [3]] });
      expect(summary).toMatchObject({ cancelled: false, failed: false, inTransaction: 'none' });
      expect(s.results.ends[0]).toBe(summary);
    });

    it('reports a failing statement, a session that cannot open and an early Cancel as error events, not thrown errors', async () => {
      const s = await setup('sqlite');
      await s.editors.associate(DOC, s.profile.id);
      const summary = await s.editors.run(DOC, { text: 'SELECT * FROM nope; SELECT 1', base: 0 });
      expect(s.results.order).toEqual(['begin', 'reveal', 'event:start', 'event:error', 'end']);
      expect(summary).toMatchObject({ failed: true, cancelled: false });

      const missing = await setup('sqlite');
      missing.profiles = [{ ...missing.profile, path: `${missing.fixture.directory}/missing.sqlite` }];
      await missing.editors.associate(DOC, missing.profile.id);
      expect(await missing.editors.run(DOC, { text: 'SELECT 1', base: 0 })).toMatchObject({ failed: true });
      expect(missing.results.events).toMatchObject([{ kind: 'error', index: 0 }]);
      expect(missing.editors.state(DOC.key)).toMatchObject({ running: false, sessionOpen: false });

      const early = await setup('sqlite');
      early.ui.cancelledAtOnce = true;
      await early.editors.associate(DOC, early.profile.id);
      expect(await early.editors.run(DOC, { text: 'SELECT 1', base: 0 })).toMatchObject({
        cancelled: true,
        failed: true,
      });
      expect(early.results.events).toMatchObject([{ kind: 'error' }]);
      expect(early.opened).toHaveLength(0);
    });

    it('cuts a result set at the setting maxRows and at the cells the results view can show', async () => {
      const s = await setup('sqlite');
      s.maxRows = 3;
      await s.editors.associate(DOC, s.profile.id);

      await s.editors.run(DOC, { text: 'SELECT * FROM range(10)', base: 0 });
      expect(s.results.events[1]).toMatchObject({ kind: 'resultSet', truncated: true });
      expect(s.results.events[1]).toMatchObject({ rows: [['0'], ['1'], ['2']] });
      s.maxRows = 100;
      await s.editors.run(DOC, { text: 'SELECT * FROM range(10)', base: 0 });
      expect(s.results.events.at(-1)).toMatchObject({ truncated: false });

      s.maxRows = 1_000_000;
      const columns = Array.from({ length: 10 }, (_, k) => `(i + ${k})::INTEGER AS c${k}`).join(', ');
      await s.editors.run(DOC, { text: `SELECT ${columns} FROM range(210000) t(i)`, base: 0 });
      const set = only(s.results.events, 'resultSet').at(-1);
      expect(set?.rows).toHaveLength(MAX_RESULT_CELLS / 10);
      expect(set).toMatchObject({ truncated: true });
      expect(set?.rows.at(-1)).toEqual(Array.from({ length: 10 }, (_, k) => 199_999 + k));
    }, 60_000);

    it('refuses a second run while one runs, ends the first with Cancel (also from the notification) and stays usable', async () => {
      const s = await setup('sqlite');
      await s.editors.associate(DOC, s.profile.id);
      const first = s.editors.run(DOC, { text: LONG_QUERY, base: 0 });
      await s.results.waitForEvent('start');

      expect(await s.editors.run(DOC, { text: 'SELECT 1', base: 0 })).toBeUndefined();
      expect(s.ui.infos).toHaveLength(1);
      expect(s.editors.state(DOC.key)?.running).toBe(true);
      s.editors.cancel(DOC.key);

      expect(await first).toMatchObject({ cancelled: true, failed: true });
      expect(s.results.events.at(-1)).toMatchObject({ kind: 'error' });
      expect(s.editors.state(DOC.key)?.running).toBe(false);
      expect(await s.editors.run(DOC, { text: 'SELECT 1', base: 0 })).toMatchObject({ failed: false });
      expect(s.opened).toHaveLength(1);

      const second = s.editors.run(DOC, { text: LONG_QUERY, base: 0 });
      await s.results.waitForEvent('start', 3);
      s.ui.cancelProgress?.();
      expect(await second).toMatchObject({ cancelled: true });
    });

    it('lets two editors on one connection run side by side, maps script ranges to the document and reads the clock of the editor', async () => {
      const s = await setup('sqlite');
      const other = OTHER_DOC;
      const ticks = [5_000, 5_250];
      s.now = () => ticks.shift() ?? 0;
      await s.editors.associate(DOC, s.profile.id);
      await s.editors.associate(other, s.profile.id);

      const summary = await s.editors.run(DOC, { text: 'BEGIN', base: 42 });
      await s.editors.run(other, { text: 'SELECT 1', base: 0 });

      expect(s.editors.state(DOC.key)?.inTransaction).toBe('open');
      expect(s.editors.state(other.key)?.inTransaction).toBe('none');
      expect(s.opened).toHaveLength(2);
      expect(s.editors.scriptRange(DOC.key, 3, 4)).toEqual({ offset: 45, length: 4 });
      expect(s.editors.scriptRange('unknown', 3, 4)).toBeUndefined();
      expect(s.results.calls[0]).toMatchObject({ call: 'begin', startedAt: 5_000 });
      expect(summary).toMatchObject({ elapsedMs: 250 });
    });

    it('reports a throwing results view as an error of the run, or fails the run, but never leaves the editor running', async () => {
      for (const method of ['begin', 'reveal'] as const) {
        const s = await setup('sqlite');
        await s.editors.associate(DOC, s.profile.id);
        s.results.failing[method] = 1;

        const summary = await s.editors.run(DOC, { text: 'SELECT 1', base: 0 });

        expect(summary, method).toMatchObject({ failed: true, cancelled: false });
        expect(s.results.events.at(-1), method).toMatchObject({ kind: 'error' });
        expect(s.editors.state(DOC.key)?.running, method).toBe(false);
        expect(await s.editors.run(DOC, { text: 'SELECT 2', base: 0 }), method).toMatchObject({
          failed: false,
        });
      }
      for (const method of ['event', 'end'] as const) {
        const s = await setup('sqlite');
        await s.editors.associate(DOC, s.profile.id);
        const reported: (boolean | undefined)[] = [];
        s.editors.onDidChange(({ key }) => reported.push(s.editors.state(key)?.running));
        s.results.failing[method] = 100;

        await expect(s.editors.run(DOC, { text: 'SELECT 1', base: 0 })).rejects.toThrow(`cannot ${method}`);

        expect(s.editors.state(DOC.key)?.running, method).toBe(false);
        expect(reported.at(-1), `${method}: the listeners are told that the run is over`).toBe(false);
        s.results.failing[method] = 0;
        expect(await s.editors.run(DOC, { text: 'SELECT 3', base: 0 }), method).toMatchObject({
          failed: false,
        });
      }
    });

    it('cancels the run when the document closes or its connection is removed in the middle of it', async () => {
      const s = await setup('sqlite');
      s.explorer.statuses.set(s.profile.id, 'connected');
      await s.editors.associate(DOC, s.profile.id);
      const running = s.editors.run(DOC, { text: `CREATE TABLE made (a INTEGER); ${LONG_QUERY}`, base: 0 });
      await s.results.waitForEvent('start', 2);

      await s.editors.documentClosed(DOC.key);

      expect(await running).toMatchObject({ cancelled: true, failed: true });
      expect(s.explorer.log).toEqual([`refresh ${s.profile.id}`]);
      expect(s.editors.connectionOf(DOC.key)).toBeUndefined();

      const removed = await setup('sqlite');
      await removed.editors.associate(DOC, removed.profile.id);
      const second = removed.editors.run(DOC, { text: LONG_QUERY, base: 0 });
      await removed.results.waitForEvent('start');
      removed.profiles = [];

      await removed.editors.profilesChanged();

      expect(await second).toMatchObject({ cancelled: true });
      expect(removed.editors.state(DOC.key)).toBeUndefined();
      expect(removed.ui.infos).toEqual([]);
    });
  });

  describe('a document without a connection', () => {
    it('asks for one and then runs, runs nothing when the question is cancelled, and does not ask when there is no connection', async () => {
      const s = await setup('sqlite');
      s.ui.answer = s.profile.id;
      const summary = await s.editors.run(DOC, { text: 'SELECT 7', base: 0 });
      expect(s.ui.picks).toEqual([[s.profile]]);
      expect(s.editors.connectionOf(DOC.key)).toBe(s.profile.id);
      expect(summary).toMatchObject({ failed: false });
      expect(s.results.events[1]).toMatchObject({ kind: 'resultSet', rows: [[7]] });

      const cancelled = await setup('sqlite');
      cancelled.ui.answer = undefined;
      expect(await cancelled.editors.run(DOC, { text: 'SELECT 7', base: 0 })).toBeUndefined();
      expect(cancelled.results.calls).toEqual([]);
      expect(cancelled.editors.connectionOf(DOC.key)).toBeUndefined();
      expect(cancelled.opened).toHaveLength(0);

      const empty = await setup('sqlite');
      empty.profiles = [];
      expect(await empty.editors.run(DOC, { text: 'SELECT 7', base: 0 })).toBeUndefined();
      expect(empty.ui.picks).toEqual([]);
      expect(empty.ui.infos).toHaveLength(1);
    });

    it('takes the only connection for a new query without asking, but asks for an explicit choice, and says when there is none', async () => {
      const s = await setup('sqlite');
      s.ui.answer = s.profile.id;
      expect(await s.editors.pickConnection()).toBe(s.profile.id);
      expect(s.ui.picks).toEqual([]);
      expect(await s.editors.pickConnection(true)).toBe(s.profile.id);
      expect(s.ui.picks).toEqual([[s.profile]]);

      const empty = await setup('sqlite');
      empty.profiles = [];
      expect(await empty.editors.pickConnection(true)).toBeUndefined();
      expect(empty.ui.picks).toEqual([]);
      expect(empty.ui.infos).toHaveLength(1);
    });
  });

  describe('the explorer after a run', () => {
    it('reads the connection again after a change, a failed script that changed something, but not after a read', async () => {
      const rows: [string, boolean][] = [
        ['INSERT INTO sales.orders (id) VALUES (9)', true],
        ['CREATE TABLE made (a INTEGER)', true],
        ['SELECT * FROM sales.orders', false],
        ['WITH x AS (SELECT 1) SELECT * FROM x', false],
        ['WITH x AS (SELECT 9 AS id) INSERT INTO sales.orders (id) SELECT id FROM x', true],
        ['EXPLAIN ANALYZE INSERT INTO sales.orders (id) VALUES (9)', true],
        ['EXPLAIN ANALYZE SELECT 1', false],
        ['INSERT INTO nope VALUES (1)', false],
        ['CREATE TABLE made (a INTEGER); SELECT * FROM nope', true],
        ['-- nothing here', false],
      ];
      for (const [text, refreshed] of rows) {
        const s = await setup('sqlite');
        s.explorer.statuses.set(s.profile.id, 'connected');
        await s.editors.associate(DOC, s.profile.id);

        await s.editors.run(DOC, { text, base: 0 });

        expect(s.explorer.log, text).toEqual(refreshed ? [`refresh ${s.profile.id}`] : []);
      }
    });

    it('waits for the COMMIT of a transaction, skips a rolled back one and reads once for a change', async () => {
      const s = await setup('sqlite');
      s.explorer.statuses.set(s.profile.id, 'connected');
      await s.editors.associate(DOC, s.profile.id);

      await s.editors.run(DOC, {
        text: 'BEGIN; CREATE TABLE made (a INTEGER); INSERT INTO made VALUES (1)',
        base: 0,
      });
      await s.editors.run(DOC, { text: 'SELECT * FROM made', base: 0 });
      expect(s.explorer.log).toEqual([]);
      await s.editors.run(DOC, { text: 'COMMIT', base: 0 });
      expect(s.explorer.log).toEqual([`refresh ${s.profile.id}`]);
      await s.editors.run(DOC, { text: 'SELECT 1', base: 0 });
      expect(s.explorer.log).toEqual([`refresh ${s.profile.id}`]);

      const rolled = await setup('sqlite');
      rolled.explorer.statuses.set(rolled.profile.id, 'connected');
      await rolled.editors.associate(DOC, rolled.profile.id);
      await rolled.editors.run(DOC, { text: 'BEGIN; CREATE TABLE gone (a INTEGER); ROLLBACK', base: 0 });
      expect(rolled.explorer.log).toEqual([]);
      await rolled.editors.run(DOC, {
        text: 'CREATE TABLE made (a INTEGER); BEGIN; INSERT INTO made VALUES (1); ROLLBACK',
        base: 0,
      });
      expect(rolled.explorer.log).toEqual([`refresh ${rolled.profile.id}`]);

      // A committed change before a BEGIN at the end of the script: the change is done, the explorer reads it now.
      const begun = await setup('sqlite');
      begun.explorer.statuses.set(begun.profile.id, 'connected');
      await begun.editors.associate(DOC, begun.profile.id);
      await begun.editors.run(DOC, { text: 'CREATE TABLE made (a INTEGER); BEGIN', base: 0 });
      expect(begun.explorer.log).toEqual([`refresh ${begun.profile.id}`]);
    });

    it('leaves an explorer alone that is not connected', async () => {
      for (const status of ['disconnected', 'connecting', 'error'] as const) {
        const s = await setup('sqlite');
        s.explorer.statuses.set(s.profile.id, status);
        await s.editors.associate(DOC, s.profile.id);

        await s.editors.run(DOC, { text: 'CREATE TABLE made (a INTEGER)', base: 0 });

        expect(s.explorer.log, status).toEqual([]);
      }
    });
  });

  describe('a DuckDB file catalog', () => {
    it('disconnects the explorer before a writable session opens and the session holds the file', async () => {
      const s = await setup('duckdb');
      s.explorer.statuses.set(s.profile.id, 'connected');
      await s.editors.associate(DOC, s.profile.id);

      await s.editors.run(DOC, { text: 'CREATE TABLE made (a INTEGER)', base: 0 });

      expect(s.explorer.log).toEqual([`disconnect ${s.profile.id}`]);
      expect(s.ui.infos).toHaveLength(1);
      expect(s.ui.infos[0]).toContain(s.profile.name);
      expect(s.results.ends).toMatchObject([{ failed: false }]);
      // The session holds the file: the explorer's reader cannot open it until the session closes.
      // Two DuckDB instances of one process conflict on a file lock only on Windows; elsewhere the lock works between
      // processes, which the end-to-end suite proves (a writer is refused while aantje is connected).
      if (process.platform === 'win32') {
        await expect(openReader(s.fixture)).rejects.toMatchObject({ code: 'LOCKED' });
      }

      for (const status of ['disconnected', 'connecting', 'error'] as const) {
        const quiet = await setup('duckdb');
        quiet.explorer.statuses.set(quiet.profile.id, status);
        await quiet.editors.associate(DOC, quiet.profile.id);
        await quiet.editors.run(DOC, { text: 'SELECT 1', base: 0 });
        expect(quiet.explorer.log, status).toEqual([`disconnect ${quiet.profile.id}`]);
        expect(quiet.ui.infos, status).toEqual([]);
      }
    });

    it('connects the explorer again when the session cannot open or the user cancels while it opens', async () => {
      const s = await setup('duckdb');
      s.profiles = [{ ...s.profile, path: `${s.fixture.directory}/missing.duckdb` }];
      s.explorer.statuses.set(s.profile.id, 'connected');
      await s.editors.associate(DOC, s.profile.id);

      const summary = await s.editors.run(DOC, { text: 'SELECT 1', base: 0 });

      expect(summary).toMatchObject({ failed: true });
      expect(s.results.events).toMatchObject([{ kind: 'error' }]);
      expect(s.explorer.log).toEqual([`disconnect ${s.profile.id}`, `connect ${s.profile.id}`]);
      expect(s.explorer.status(s.profile.id)).toBe('connected');
      expect(s.ui.infos).toEqual([]);

      const idle = await setup('duckdb');
      idle.profiles = [{ ...idle.profile, path: `${idle.fixture.directory}/missing.duckdb` }];
      await idle.editors.associate(DOC, idle.profile.id);
      await idle.editors.run(DOC, { text: 'SELECT 1', base: 0 });
      expect(idle.explorer.log).toEqual([`disconnect ${idle.profile.id}`]);

      const cancelled = await setup('duckdb');
      cancelled.explorer.statuses.set(cancelled.profile.id, 'connected');
      await cancelled.editors.associate(DOC, cancelled.profile.id);
      const running = cancelled.editors.run(DOC, { text: 'SELECT 1', base: 0 });
      expect(cancelled.explorer.log).toEqual([`disconnect ${cancelled.profile.id}`]);
      cancelled.ui.cancelProgress?.();
      expect(await running).toMatchObject({ cancelled: true });
      expect(cancelled.explorer.log).toEqual([
        `disconnect ${cancelled.profile.id}`,
        `connect ${cancelled.profile.id}`,
      ]);
      expect(cancelled.editors.state(DOC.key)).toMatchObject({ sessionOpen: false, running: false });
    });

    it('connects the explorer again when the editor that holds the file closes, but not for a removed connection or on dispose', async () => {
      const s = await setup('duckdb');
      s.explorer.statuses.set(s.profile.id, 'connected');
      await s.editors.associate(DOC, s.profile.id);
      await s.editors.run(DOC, { text: 'CREATE TABLE made (a INTEGER)', base: 0 });

      await s.editors.documentClosed(DOC.key);

      expect(s.explorer.log).toEqual([`disconnect ${s.profile.id}`, `connect ${s.profile.id}`]);
      const reader = await openReader(s.fixture);
      cleanups.push(() => reader.close());

      const toggled = await setup('duckdb');
      toggled.explorer.statuses.set(toggled.profile.id, 'connected');
      await toggled.editors.associate(DOC, toggled.profile.id);
      await toggled.editors.run(DOC, { text: 'SELECT 1', base: 0 });
      await toggled.editors.toggleMode(DOC.key);
      expect(toggled.explorer.log).toEqual([
        `disconnect ${toggled.profile.id}`,
        `connect ${toggled.profile.id}`,
      ]);

      const removed = await setup('duckdb');
      removed.explorer.statuses.set(removed.profile.id, 'connected');
      await removed.editors.associate(DOC, removed.profile.id);
      await removed.editors.run(DOC, { text: 'SELECT 1', base: 0 });
      removed.profiles = [];
      await removed.editors.profilesChanged();
      expect(removed.explorer.log).toEqual([`disconnect ${removed.profile.id}`]);

      const disposed = await setup('duckdb');
      disposed.explorer.statuses.set(disposed.profile.id, 'connected');
      await disposed.editors.associate(DOC, disposed.profile.id);
      await disposed.editors.run(DOC, { text: 'SELECT 1', base: 0 });
      await disposed.editors.dispose();
      expect(disposed.explorer.log).toEqual([`disconnect ${disposed.profile.id}`]);
    });

    it('shares the file with a read-only session, and leaves an explorer on a SQLite catalog connected', async () => {
      const s = await setup('duckdb', { readOnly: true });
      s.explorer.statuses.set(s.profile.id, 'connected');
      await s.editors.associate(DOC, s.profile.id);

      await s.editors.run(DOC, { text: 'SELECT count(*)::INTEGER FROM sales.orders', base: 0 });

      expect(s.explorer.log).toEqual([]);
      expect(s.ui.infos).toEqual([]);
      expect(s.results.events[1]).toMatchObject({ kind: 'resultSet', rows: [[2]] });
      const reader: CatalogReader = await openReader(s.fixture);
      cleanups.push(() => reader.close());
      expect((await reader.snapshots())[0]?.id).toBeGreaterThan(0);

      const sqlite = await setup('sqlite');
      sqlite.explorer.statuses.set(sqlite.profile.id, 'connected');
      await sqlite.editors.associate(DOC, sqlite.profile.id);
      await sqlite.editors.run(DOC, { text: 'SELECT 1', base: 0 });
      expect(sqlite.explorer.log).toEqual([]);
    });

    it('holds the file exclusively only for a writable DuckDB file session', () => {
      const file = (kind: 'duckdb' | 'sqlite'): FileProfile => ({ id: 'f', name: 'f', kind, path: '/f' });
      const postgres = {
        id: 'p',
        name: 'p',
        kind: 'postgres',
        host: 'h',
        port: 5432,
        database: 'd',
        user: 'u',
      } as const;
      expect(holdsFileExclusively(file('duckdb'), 'read-write')).toBe(true);
      expect(holdsFileExclusively(file('duckdb'), 'read-only')).toBe(false);
      expect(holdsFileExclusively(file('sqlite'), 'read-write')).toBe(false);
      expect(holdsFileExclusively(postgres, 'read-write')).toBe(false);
    });
  });
});

describe('the pure helpers of the editor', () => {
  it('tells the statements that change the catalog from the ones that only read', () => {
    const rows: [string, boolean][] = [
      ['SELECT * FROM sales.orders', false],
      ['VALUES (1), (2)', false],
      ['SHOW TABLES', false],
      ['SET threads = 1', false],
      ['BEGIN', false],
      ['ROLLBACK', false],
      ['LOAD ducklake', false],
      ['WITH x AS (SELECT 1) SELECT * FROM x', false],
      ['EXPLAIN INSERT INTO sales.orders (id) VALUES (9)', false],
      ['EXPLAIN ANALYZE SELECT 1', false],
      ['INSERT INTO sales.orders (id) VALUES (9)', true],
      ['UPDATE sales.orders SET id = id', true],
      ['DELETE FROM sales.orders', true],
      ['MERGE INTO sales.orders USING t ON true WHEN MATCHED THEN DELETE', true],
      ['CREATE TABLE t (a INTEGER)', true],
      ['DROP TABLE t', true],
      ['COMMIT', true],
      ['CALL ducklake_flush_inlined_data()', true],
      ["COPY t FROM 't.csv'", true],
      ['with x as (select 1 as id) delete from sales.orders where id in (select id from x)', true],
      ['EXPLAIN ANALYZE CREATE TABLE t AS SELECT 1', true],
      ['explain (analyze) insert into sales.orders (id) values (9)', true],
      ['EXPLAIN (FORMAT JSON, ANALYZE) DELETE FROM sales.orders', true],
    ];
    for (const [sql, expected] of rows) {
      const type = sql.trim().split(/[\s(]/)[0]?.toUpperCase() ?? '';
      expect(changesCatalog({ type, sql }), sql).toBe(expected);
    }
  });

  it('runs the selection when it holds more than blanks, else the whole document', () => {
    const text = 'SELECT 1;\n  SELECT 2;\n';
    expect(scriptToRun(text, { start: 12, end: 21 })).toEqual({ text: 'SELECT 2;', base: 12 });
    expect(scriptToRun(text, { start: 5, end: 5 })).toEqual({ text, base: 0 });
    expect(scriptToRun(text, { start: 9, end: 12 })).toEqual({ text, base: 0 });
  });

  it('shows the connection in the status bar and tells the modes and the transaction states apart', () => {
    const states = [
      ['read-write', 'none'],
      ['read-only', 'none'],
      ['read-write', 'open'],
      ['read-only', 'aborted'],
    ] as const;
    const contents = states.map(([mode, inTransaction]) =>
      queryStatusContent({ connectionName: 'Fixture', mode, inTransaction }),
    );
    for (const content of contents) {
      expect(content.text).toContain('Fixture');
      expect(content.tooltip).toContain('Fixture');
    }
    expect(new Set(contents.map(({ text }) => text)).size).toBe(4);
    expect(new Set(contents.map(({ tooltip }) => tooltip)).size).toBe(4);
  });

  it('offers the menu actions that apply to the state of the session', () => {
    const actions = (
      state: Omit<Parameters<typeof queryMenuItems>[0], 'switchable'>,
      switchable = true,
    ): string[] => queryMenuItems({ ...state, switchable }).map(({ action }) => action);
    expect(actions({ mode: 'read-write', running: false, sessionOpen: false })).toEqual(['select', 'toggle']);
    expect(actions({ mode: 'read-only', running: false, sessionOpen: true })).toEqual([
      'select',
      'toggle',
      'close',
    ]);
    expect(actions({ mode: 'read-write', running: true, sessionOpen: true })).toEqual([
      'select',
      'toggle',
      'cancel',
    ]);
    // A Quack session has full access only: there is nothing to switch to.
    expect(actions({ mode: 'read-write', running: false, sessionOpen: true }, false)).toEqual([
      'select',
      'close',
    ]);
  });

  it('keeps a session on a Quack catalog read/write: what the token may do is up to the server', async () => {
    const quack: ConnectionProfile = {
      id: 'q',
      name: 'Served',
      kind: 'quack',
      host: 'duckdb',
      port: 9494,
      ssl: true,
    };
    const ui = new FakeUi();
    const editors = new QueryEditors({
      profiles: { list: () => [quack], get: (id) => (id === quack.id ? quack : undefined) },
      openSession: () => Promise.reject(new Error('The test opens no session.')),
      results: new FakeResults(),
      explorer: new FakeExplorer(),
      ui,
      maxRows: () => 10,
    });
    await editors.associate(DOC, quack.id);

    await editors.toggleMode(DOC.key);

    expect(editors.state(DOC.key)).toMatchObject({ mode: 'read-write', switchable: false });
    expect(ui.infos).toHaveLength(1);
    expect(holdsFileExclusively(quack, 'read-write')).toBe(false);
  });
});

describe.skipIf(skipReason)('the cell room that a run gives the session', () => {
  async function session(): Promise<SqlSession> {
    const fixture = await copyDataFixture('sqlite');
    cleanups.push(() => fixture.remove());
    const opened = await openSqlSession({ access: accessFor(fixture), mode: 'read-only' });
    cleanups.push(() => opened.close());
    return opened;
  }

  it('reads a result set only as far as it fits, gives the next ones what is left, and keeps the smaller of rows and cells', async () => {
    const script = [
      'SELECT i::INTEGER AS a, i::INTEGER AS b FROM range(3) t(i)',
      'SELECT i::INTEGER AS c FROM range(5) t(i)',
      'SELECT i::INTEGER AS d FROM range(3) t(i)',
      'SELECT 1::INTEGER AS e WHERE false',
    ].join('; ');

    const sets = only(await events(await session(), script, { maxCells: 10 }), 'resultSet');

    expect(sets.map(({ rows, truncated }) => [rows.length, truncated])).toEqual([
      [3, false],
      [4, true],
      [0, true],
      [0, false],
    ]);
    expect(sets[2]?.columns.map(({ name }) => name)).toEqual(['d']);
    expect(sets[1]?.rows).toEqual([[0], [1], [2], [3]]);

    const [byRows] = only(
      await events(await session(), 'SELECT i::INTEGER AS a FROM range(50) t(i)', {
        maxRows: 5,
        maxCells: 1_000,
      }),
      'resultSet',
    );
    const [wide] = only(
      await events(await session(), 'SELECT i::INTEGER AS a, 1 AS b, 2 AS c FROM range(50) t(i)', {
        maxRows: 20,
        maxCells: 30,
      }),
      'resultSet',
    );
    expect([byRows?.rows.length, byRows?.truncated]).toEqual([5, true]);
    expect([wide?.rows.length, wide?.truncated]).toEqual([10, true]);

    // A run that sets no cell limit is limited by its rows only.
    const [unlimited] = only(
      await events(await session(), 'SELECT i::INTEGER FROM range(30000) t(i)'),
      'resultSet',
    );
    expect(unlimited).toMatchObject({ truncated: true });
    expect(unlimited?.rows).toHaveLength(10_000);
  });
});

describe.skipIf(skipReason)('the statement at the cursor', () => {
  const service = openLanguageService();
  afterAll(() => service.dispose());

  /** The statement at the offset of the `|` in the text. */
  async function at(marked: string): Promise<string | undefined> {
    const offset = marked.indexOf('|');
    const text = marked.replace('|', '');
    const found = statementAt(text, await service.tokenize(text), offset);
    if (found) expect(text.slice(found.base, found.base + found.text.length)).toBe(found.text);
    return found?.text;
  }

  it('picks the statement around the cursor, the previous one between statements, and ignores terminators in strings and comments', async () => {
    const rows: [string, string][] = [
      ['SEL|ECT 1; SELECT 2; SELECT 3', 'SELECT 1'],
      ['SELECT 1; SELECT |2; SELECT 3', 'SELECT 2'],
      ['SELECT 1; SELECT 2; SEL|ECT 3', 'SELECT 3'],
      ['SELECT 1; |SELECT 2', 'SELECT 2'],
      ['SELECT 1;| SELECT 2', 'SELECT 1'],
      ['SELECT 1;\n|\nSELECT 2', 'SELECT 1'],
      ['SELECT 1; SELECT 2;  |', 'SELECT 2'],
      ['  |  SELECT 1; SELECT 2', 'SELECT 1'],
      ['SELECT 1|; SELECT 2', 'SELECT 1'],
      ["SELECT 'a;b' AS x; SELECT |2", 'SELECT 2'],
      ["SELECT 'a;|b' AS x; SELECT 2", "SELECT 'a;b' AS x"],
      ['SELECT 1 AS "a;b"; SELECT |2', 'SELECT 2'],
      ['SELECT 1 -- on|e; two\n, 2; SELECT 3', 'SELECT 1 -- one; two\n, 2'],
      ['SELECT 1 /* a; b */ + 2; SELECT |3', 'SELECT 3'],
      ['SELECT $$a;b$$ AS x; SELECT |2', 'SELECT 2'],
      ['-- first\nSELECT |1; SELECT 2', 'SELECT 1'],
      [';; SELECT |1', 'SELECT 1'],
      ['SELECT 1,\n  2\nFROM x;\nSELECT |3', 'SELECT 3'],
      ["SELECT 'äöü 😀 日|本' AS a; SELECT 2", "SELECT 'äöü 😀 日本' AS a"],
      ['SELECT 1;\r\nSELECT 2;\r\n\r\n|\r\nSELECT 3', 'SELECT 2'],
      ['SELECT 1;\r\nSELECT 2;\r\nSEL|ECT 3', 'SELECT 3'],
    ];
    for (const [marked, expected] of rows) expect(await at(marked), marked).toBe(expected);
  });

  it('gives the base of the statement in the document and finds nothing in a text without a statement', async () => {
    const text = '-- lead\nSELECT 1;\n  SELECT 2';
    const found = statementAt(text, await service.tokenize(text), text.length);
    expect(found).toEqual({ text: 'SELECT 2', base: text.indexOf('SELECT 2') });

    for (const marked of ['|', '-- only a comment|', ';;|']) {
      expect(await at(marked), marked).toBeUndefined();
    }
  });
});

describe.skipIf(skipReason)('the catalog that completion reads', () => {
  it('is made once per connection, snapshot and reader, and made again when one of them changes', async () => {
    const fixture = await copyDataFixture('sqlite');
    cleanups.push(() => fixture.remove());
    const first = await openReader(fixture);
    const second = await openReader(fixture);
    cleanups.push(() => first.close());
    cleanups.push(() => second.close());
    const readers = new Map<string, CatalogReader>([['a', first]]);
    const snapshots = new Map<string, number>([['a', 13]]);
    const cache = catalogCache({ reader: (id) => readers.get(id), snapshot: (id) => snapshots.get(id) });

    const catalog = cache.of('a');
    expect(catalog).toBeDefined();
    expect((await catalog?.schemas())?.map(({ name }) => name)).toContain('sales');
    expect(cache.of('a')).toBe(catalog);
    expect(cache.of('unknown')).toBeUndefined();

    snapshots.set('a', 12);
    const older = cache.of('a');
    expect(older).not.toBe(catalog);
    readers.set('a', second);
    expect(cache.of('a')).not.toBe(older);

    const current = cache.of('a');
    cache.invalidate();
    expect(cache.of('a')).not.toBe(current);

    const beforeRemoval = cache.of('a');
    readers.delete('a');
    expect(cache.of('a')).toBeUndefined();
    // A reader that comes back is a new connection: nothing of the catalog that was made before is reused.
    readers.set('a', second);
    expect(cache.of('a')).not.toBe(beforeRemoval);
  });
});
