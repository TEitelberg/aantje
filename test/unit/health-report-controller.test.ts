import { describe, expect, it } from 'vitest';
import { AantjeError } from '../../src/errors';
import type { HealthEvent, HealthReport, HealthRequest, HealthSummary } from '../../src/health/model';
import type { HealthRun } from '../../src/health/run';
import { createHealthController } from '../../src/health-report/controller';
import type { HealthPanels, HealthTarget } from '../../src/health-report/controller';
import { healthKey } from '../../src/health-report/model';
import type { HealthData, PanelEvent } from '../../src/health-report/model';
import type { HealthAction } from '../../src/health-report/protocol';
import { customers, events, sampleFinding } from './health-report-support';

const BATCH_MS = 100;

const lake = { kind: 'lake' } as const;

const summary = (changes: Partial<HealthSummary> = {}): HealthSummary => ({
  errors: 0,
  warnings: 0,
  infos: 0,
  omitted: 0,
  elapsedMs: 10,
  cancelled: false,
  ...changes,
});

/** The panels of the reports with a stand-in: what was shown and what was posted to the page, in order. */
function fakePanels() {
  const shown: { key: string; title: string; data: HealthData }[] = [];
  const updates: { key: string; data: HealthData; events: PanelEvent[] }[] = [];
  const panels: HealthPanels = {
    show: (key, title, data) => shown.push({ key, title, data }),
    update: (key, data, message) =>
      updates.push({ key, data, events: (message as { data: { events: PanelEvent[] } }).data.events }),
  };
  return { panels, shown, updates };
}

/** The timer of the batches, by hand. */
function fakeTimer() {
  let next = 0;
  const waiting = new Map<number, () => void>();
  return {
    timer: {
      set: (fn: () => void, ms: number): unknown => {
        expect(ms).toBe(BATCH_MS);
        waiting.set(++next, fn);
        return next;
      },
      clear: (handle: unknown) => void waiting.delete(handle as number),
    },
    pending: () => waiting.size,
    fire: () => {
      const all = [...waiting.values()];
      waiting.clear();
      all.forEach((fn) => fn());
    },
  };
}

/** A check that the test steers: it reports the events it is given and ends when the test says so. */
function fakeCheck() {
  const calls: { target: HealthTarget; request: HealthRequest; run: HealthRun }[] = [];
  let finish: ((report: HealthReport) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  return {
    calls,
    check: (target: HealthTarget, request: HealthRequest, run: HealthRun): Promise<HealthReport> => {
      calls.push({ target, request, run });
      return new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
    },
    emit: (...list: HealthEvent[]) => list.forEach((event) => calls.at(-1)?.run.onEvent?.(event)),
    end: (snapshot: number | undefined = 56, changes: Partial<HealthReport> = {}) =>
      finish?.({
        request: calls.at(-1)?.request as HealthRequest,
        ...(snapshot === undefined ? {} : { snapshot }),
        groups: [],
        findings: [],
        summary: summary(),
        ...changes,
      }),
    reject: (error: unknown) => fail?.(error),
    signal: () => calls.at(-1)?.run.signal,
  };
}

const target = (changes: Partial<HealthTarget> = {}): HealthTarget => ({
  connectionId: 'lake-1',
  connectionName: 'Lake',
  scope: lake,
  snapshot: 56,
  ...changes,
});

function setup() {
  const view = fakePanels();
  const clock = fakeTimer();
  const check = fakeCheck();
  const performed: unknown[] = [];
  const outcome: { value: 'rerun' | undefined; gate?: Promise<'rerun' | undefined> } = { value: undefined };
  const warnings: string[] = [];
  const controller = createHealthController({
    panels: view.panels,
    logger: { warn: (message) => warnings.push(message) },
    check: check.check,
    perform: (plan, forTarget) => {
      performed.push({ plan, connectionId: forTarget.connectionId });
      return outcome.gate ?? Promise.resolve(outcome.value);
    },
    timer: clock.timer,
  });
  const key = healthKey('lake-1', lake);
  const act = (message: Record<string, unknown>): Promise<void> =>
    controller.act(key, { type: 'action', ...message } as HealthAction);
  return { ...view, ...clock, ...check, controller, performed, outcome, warnings, key, act };
}

const idle = Promise.resolve();
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('opening the panel of a check', () => {
  it('starts the quick check at once, keeps one panel per scope and reveals a running check instead of starting another', () => {
    const { controller, shown, calls } = setup();
    controller.open(target(), { run: true });

    expect(shown[0]).toMatchObject({
      key: healthKey('lake-1', lake),
      data: {
        connection: 'Lake',
        scope: lake,
        depth: 'quick',
        deepFiles: 200,
        status: 'running',
        findings: [],
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toEqual({ scope: { kind: 'lake' }, depth: 'quick', snapshot: 56 });
    expect(calls[0]?.target).toEqual(target());

    controller.open(target(), { run: true });
    expect(calls).toHaveLength(1);
    expect(shown).toHaveLength(2);
    expect(shown[1]?.data.status).toBe('running');

    controller.open(target({ scope: events }), { run: true });
    controller.open(target({ scope: customers }), { run: true });
    expect(calls[1]?.request.scope).toEqual({ kind: 'table', tableId: 3 });
    expect(new Set(shown.map(({ key }) => key)).size).toBe(3);
    expect(calls).toHaveLength(3);

    // A schema that has the id of a table is another panel and a check of the schema.
    controller.open(target({ scope: { kind: 'schema', id: 3, name: 'shop' } }), { run: true });
    expect(calls[3]?.request.scope).toEqual({ kind: 'schema', schemaId: 3 });
    expect(new Set(shown.map(({ key }) => key)).size).toBe(4);

    const idleView = setup();
    idleView.controller.open(target());
    expect(idleView.shown[0]?.data.status).toBe('idle');
    expect(idleView.calls).toHaveLength(0);
  });

  it('takes the target of a new open: a renamed connection and the snapshot the tree shows now', async () => {
    const { controller, shown, calls, emit, end } = setup();
    controller.open(target(), { run: true });
    emit({ type: 'summary', summary: summary() });
    end();
    await settled();

    controller.open(target({ connectionName: 'Renamed lake', snapshot: 60 }));
    expect(shown.at(-1)?.title).toContain('Renamed lake');
    expect(shown.at(-1)?.data.connection).toBe('Renamed lake');
    controller.open(target({ connectionName: 'Renamed lake', snapshot: 60 }), { run: true });
    expect(calls.at(-1)?.request).toMatchObject({ snapshot: 60 });
    expect(shown.at(-1)?.title).toContain('Renamed lake');
  });

  it('starts a new quick check when the panel of a finished run is opened with a run again, also after a deep run', async () => {
    const { controller, shown, calls, emit, end, act } = setup();
    const finished = (): void => {
      emit({ type: 'summary', summary: summary() });
      end();
    };
    controller.open(target(), { run: true });
    emit({ type: 'finding', finding: sampleFinding('catalog.snapshot-gaps', 'info', lake) });
    finished();
    await settled();
    // What pressing the button of an error message twice does: the second press is a run again.
    controller.open(target(), { run: true });
    expect(calls).toHaveLength(2);
    expect(shown.at(-1)?.data).toMatchObject({ status: 'running', findings: [] });

    finished();
    await settled();
    void act({ action: 'run', depth: 'deep', deepFiles: 50 });
    expect(calls[2]?.request).toEqual({
      scope: { kind: 'lake' },
      depth: 'deep',
      snapshot: 56,
      limits: { deepFiles: 50 },
    });
    expect(shown.at(-1)?.data).toMatchObject({
      status: 'running',
      depth: 'deep',
      deepFiles: 50,
      findings: [],
      groups: [],
    });
    expect(shown.at(-1)?.data.summary).toBeUndefined();
    finished();
    await settled();
    controller.open(target(), { run: true });

    expect(calls).toHaveLength(4);
    expect(calls[3]?.request).toEqual({ scope: { kind: 'lake' }, depth: 'quick', snapshot: 56 });
  });
});

describe('a run reports to the page', () => {
  it('sends groups at once, findings in batches in the order they happened, and the newest progress only', () => {
    const { controller, updates, emit, fire, pending } = setup();
    controller.open(target(), { run: true });
    const first = sampleFinding('catalog.snapshot-gaps', 'info', lake);
    const second = sampleFinding('catalog.cleanup-pending', 'info', lake);

    emit({ type: 'group', status: { group: 'catalog', state: 'running' } });
    expect(updates.map(({ events: sent }) => sent.map((e) => e.type))).toEqual([['group']]);

    emit({ type: 'finding', finding: first }, { type: 'finding', finding: second });
    expect(updates).toHaveLength(1);
    expect(pending()).toBe(1);
    fire();
    expect(updates[1]?.events).toEqual([
      { type: 'finding', finding: first },
      { type: 'finding', finding: second },
    ]);
    expect(updates[1]?.data.findings.map(({ id }) => id)).toEqual([first.id, second.id]);
    expect(pending()).toBe(0);

    // A finding before a group event travels with it.
    emit({ type: 'finding', finding: first }, { type: 'group', status: { group: 'catalog', state: 'done' } });
    expect(updates.at(-1)?.events.map((e) => e.type)).toEqual(['finding', 'group']);

    const progress = setup();
    progress.controller.open(target(), { run: true });
    for (let done = 0; done < 200; done++) {
      progress.emit({ type: 'progress', group: 'deep', done, total: 200 });
    }
    progress.fire();
    expect(progress.updates).toHaveLength(1);
    expect(progress.updates[0]?.events).toEqual([{ type: 'progress', group: 'deep', done: 199, total: 200 }]);
    expect(progress.updates[0]?.data.progress).toEqual({ group: 'deep', done: 199, total: 200 });

    const many = setup();
    many.controller.open(target(), { run: true });
    for (let index = 0; index < 2000; index++) {
      many.emit({
        type: 'finding',
        finding: sampleFinding('storage.file-orphaned', 'info', lake, { object: `k${index}` }),
      });
    }
    many.fire();
    expect(many.updates).toHaveLength(1);
    expect(many.updates[0]?.data.findings).toHaveLength(2000);
  });

  it('ends with the summary and the snapshot, and shows a failed run with the message of a user error only', async () => {
    const done = setup();
    done.controller.open(target(), { run: true });
    done.emit({ type: 'summary', summary: summary({ infos: 1 }) });
    done.end(56);
    await idle;
    expect(done.updates.at(-1)?.events).toEqual([{ type: 'snapshot', snapshot: 56 }]);
    expect(done.updates.at(-1)?.data).toMatchObject({
      status: 'done',
      snapshot: 56,
      summary: summary({ infos: 1 }),
    });
    expect(done.shown).toHaveLength(1);

    const user = setup();
    user.controller.open(target(), { run: true });
    user.reject(new AantjeError('CONNECTION_FAILED', 'closed-connection-message'));
    await idle;
    expect(user.updates.at(-1)?.data).toMatchObject({
      status: 'failed',
      message: 'closed-connection-message',
    });

    const other = setup();
    other.controller.open(target(), { run: true });
    other.reject(new Error('ENOENT: C:\\secret\\path'));
    await idle;
    expect(other.updates.at(-1)?.data.status).toBe('failed');
    expect(other.updates.at(-1)?.data.message).not.toContain('secret');
  });
});

describe('what the page asks for', () => {
  it('cancels through the signal and shows what was found so far; run and cancel out of turn are ignored', async () => {
    const { controller, updates, emit, signal, act, end, calls, warnings } = setup();
    controller.open(target(), { run: true });
    await act({ action: 'run', depth: 'quick', deepFiles: 200 });
    expect(calls).toHaveLength(1);
    expect(warnings).toHaveLength(1);

    emit({ type: 'finding', finding: sampleFinding('catalog.cleanup-overdue', 'warning', lake) });
    expect(signal()?.aborted).toBe(false);
    await act({ action: 'cancel' });
    expect(signal()?.aborted).toBe(true);

    // The engine ends the run the way it does when the signal is aborted.
    emit(
      { type: 'group', status: { group: 'storage', state: 'skipped', reason: 'Cancelled.' } },
      { type: 'summary', summary: summary({ warnings: 1, cancelled: true }) },
    );
    end();
    await idle;
    expect(updates.at(-1)?.data).toMatchObject({ status: 'cancelled' });
    expect(updates.at(-1)?.data.findings.map(({ id }) => id)).toEqual(['catalog.cleanup-overdue']);

    const none = setup();
    none.controller.open(target());
    await none.act({ action: 'cancel' });
    expect(none.warnings).toHaveLength(1);
  });

  it('hands the actions of a finding to the extension with the connection, and refuses unsent findings and unknown panels', async () => {
    const { controller, emit, fire, act, performed, warnings } = setup();
    controller.open(target(), { run: true });
    const found = sampleFinding('catalog.small-files', 'info', events, {
      object: 'table:3',
      inspectSql: 'SELECT 1',
    });
    const unsent = sampleFinding('catalog.snapshot-gaps', 'info', lake);
    emit({ type: 'finding', finding: found });
    fire();
    // Not sent yet: it is in a batch that has not been flushed.
    emit({ type: 'finding', finding: unsent });
    await act({ action: 'inspect', finding: unsent.id });
    await controller.act('[]', { type: 'action', action: 'cancel' });
    expect(performed).toEqual([]);
    expect(warnings).toHaveLength(2);

    await act({ action: 'inspect', finding: found.id });
    await act({ action: 'revealTable', finding: found.id });
    await act({ action: 'script', finding: found.id });
    expect(performed).toEqual([
      { plan: { action: 'inspect', sql: 'SELECT 1' }, connectionId: 'lake-1' },
      {
        plan: { action: 'revealTable', table: { id: 3, schema: 'shop', name: 'events' } },
        connectionId: 'lake-1',
      },
      {
        plan: { action: 'script', kind: 'merge', table: { id: 3, schema: 'shop', name: 'events' } },
        connectionId: 'lake-1',
      },
    ]);
  });

  describe('an action that changes the setup', () => {
    const suggestion = {
      endpoint: 'http://rustfs:9000',
      urlStyle: 'path',
      source: 'AWS_ENDPOINT_URL_S3',
    } as const;
    const notSet = sampleFinding('connection.endpoint-not-set', 'error', lake, { suggestion });

    /** A panel whose run has ended with the finding in it. */
    function finished() {
      const rig = setup();
      rig.controller.open(target(), { run: true });
      rig.emit({ type: 'finding', finding: notSet }, { type: 'summary', summary: summary({ errors: 1 }) });
      rig.fire();
      rig.end();
      return rig;
    }

    it('runs the quick check again when the setup may have changed, and leaves the panel alone when the user declined', async () => {
      const { act, performed, outcome, calls, updates, shown, emit, fire, end } = finished();
      await settled();
      const before = shown.length;
      await act({ action: 'useEndpoint', finding: notSet.id });
      await settled();
      expect(performed).toHaveLength(1);
      expect(calls).toHaveLength(1);
      expect(shown).toHaveLength(before);

      performed.length = 0;
      outcome.value = 'rerun';
      const acting = act({ action: 'useEndpoint', finding: notSet.id });
      await settled();
      expect(performed).toEqual([
        {
          plan: {
            action: 'useEndpoint',
            endpoint: 'http://rustfs:9000',
            urlStyle: 'path',
            source: 'AWS_ENDPOINT_URL_S3',
          },
          connectionId: 'lake-1',
        },
      ]);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.request).toEqual({ scope: { kind: 'lake' }, depth: 'quick', snapshot: 56 });
      // The panel starts over: the findings of the old run are gone until the new run reports.
      expect(shown.at(-1)?.data).toMatchObject({ status: 'running', findings: [] });
      emit({ type: 'summary', summary: summary() });
      fire();
      end();
      await acting;
      expect(updates.at(-1)?.data).toMatchObject({ status: 'done', findings: [] });
    });

    it('does not start a second run when the user started one while the credentials were being asked for', async () => {
      const { act, outcome, calls, end, performed } = finished();
      await settled();
      let release: (value: 'rerun') => void = () => undefined;
      outcome.gate = new Promise((resolve) => (release = resolve));

      const acting = act({ action: 'setCredentials', finding: notSet.id });
      await settled();
      const running = act({ action: 'run', depth: 'quick', deepFiles: 200 });
      await settled();
      expect(calls).toHaveLength(2);
      release('rerun');
      await settled();

      expect(performed).toEqual([{ plan: { action: 'setCredentials' }, connectionId: 'lake-1' }]);
      expect(calls, 'the run of the user is the only one').toHaveLength(2);
      end();
      await Promise.all([acting, running]);
    });

    it('performs nothing, and runs nothing again, while a check is running', async () => {
      const missing = sampleFinding('connection.credentials-missing', 'warning', lake);
      const { controller, emit, fire, act, performed, calls, warnings, outcome } = setup();
      controller.open(target(), { run: true });
      emit({ type: 'finding', finding: notSet }, { type: 'finding', finding: missing });
      fire();
      outcome.value = 'rerun';

      await act({ action: 'useEndpoint', finding: notSet.id });
      await act({ action: 'setCredentials', finding: missing.id });

      expect(performed).toEqual([]);
      expect(calls).toHaveLength(1);
      expect(warnings).toHaveLength(2);
    });
  });
});

describe('closing the panel', () => {
  it('stops the run, drops what it reports afterwards, forgets a pending batch and opens a fresh panel the next time', async () => {
    const { controller, updates, emit, signal, calls, key, shown, end, pending, fire } = setup();
    controller.open(target(), { run: true });
    const found = sampleFinding('catalog.snapshot-gaps', 'info', lake);
    emit({ type: 'group', status: { group: 'catalog', state: 'running' } });
    emit({ type: 'finding', finding: found });
    const count = updates.length;

    controller.close(key);
    expect(signal()?.aborted).toBe(true);
    fire();
    expect(pending()).toBe(0);

    emit({ type: 'group', status: { group: 'catalog', state: 'done' } }, { type: 'finding', finding: found });
    end();
    await idle;
    expect(updates).toHaveLength(count);

    controller.open(target(), { run: true });
    expect(calls).toHaveLength(2);
    expect(shown.at(-1)?.data).toMatchObject({ status: 'running', findings: [] });

    controller.dispose();
    expect(signal()?.aborted).toBe(true);
  });
});
