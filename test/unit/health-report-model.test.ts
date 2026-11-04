import { describe, expect, it } from 'vitest';
import { CHECKS } from '../../src/health/model';
import type { GroupStatus, HealthSummary } from '../../src/health/model';
import {
  DEFAULT_FILTER,
  actionsOf,
  applyHealthEvent,
  applyEvents,
  counts,
  freshData,
  healthCards,
  healthKey,
  healthScriptOf,
  matchingFindings,
  sections,
  verdict,
} from '../../src/health-report/model';
import type { HealthData } from '../../src/health-report/model';
import { engineSkipReason } from './data-support';
import { breakHistory, customers, events, runOnHistory, sampleFinding } from './health-report-support';

const lake = { kind: 'lake' } as const;
const choice = { depth: 'quick', deepFiles: 200 } as const;
const summary = (changes: Partial<HealthSummary> = {}): HealthSummary => ({
  errors: 0,
  warnings: 0,
  infos: 0,
  omitted: 0,
  elapsedMs: 1500,
  cancelled: false,
  ...changes,
});
const done = (group: GroupStatus['group'], more: Partial<GroupStatus> = {}): GroupStatus => ({
  group,
  state: 'done',
  ...more,
});

describe('the data of a run, event by event', () => {
  it('starts empty, orders groups like the engine, adds a finding once and does not mutate its input', () => {
    const fresh = freshData('Lake', lake, choice, 'running');
    expect(fresh).toEqual({
      connection: 'Lake',
      scope: lake,
      depth: 'quick',
      deepFiles: 200,
      status: 'running',
      groups: [],
      findings: [],
    });
    const frozen = JSON.stringify(fresh);
    const first = sampleFinding('catalog.snapshot-gaps', 'info', lake);
    const second = sampleFinding('catalog.negative-counts', 'error', events);
    const data = applyEvents(fresh, [
      { type: 'group', status: done('storage') },
      { type: 'group', status: { group: 'catalog', state: 'running' } },
      { type: 'group', status: done('catalog') },
      { type: 'finding', finding: first },
      { type: 'finding', finding: second },
      { type: 'finding', finding: first },
    ]);
    expect(JSON.stringify(fresh)).toBe(frozen);
    expect(data.groups.map(({ group, state }) => `${group}:${state}`)).toEqual([
      'catalog:done',
      'storage:done',
    ]);
    expect(data.findings.map(({ id }) => id)).toEqual([first.id, second.id]);
  });

  it('shows the position of the deep check until its group ends, the summary or a failure', () => {
    let data = applyEvents(freshData('Lake', lake, choice, 'running'), [
      { type: 'group', status: { group: 'deep', state: 'running' } },
      { type: 'progress', group: 'deep', done: 3, total: 200 },
    ]);
    expect(data.progress).toEqual({ group: 'deep', done: 3, total: 200 });
    const running = applyHealthEvent(data, { type: 'group', status: { group: 'storage', state: 'running' } });
    expect(running.progress).toEqual({ group: 'deep', done: 3, total: 200 });

    data = applyHealthEvent(running, { type: 'group', status: done('deep') });
    expect(data.progress).toBeUndefined();
    expect(applyHealthEvent(running, { type: 'failed', message: 'x' }).progress).toBeUndefined();
    expect(
      applyHealthEvent(running, { type: 'summary', summary: summary({ cancelled: true }) }).progress,
    ).toBeUndefined();
  });

  it('ends with the summary (done or cancelled), the checked snapshot, or a failure', () => {
    const data = freshData('Lake', lake, choice, 'running');
    expect(applyHealthEvent(data, { type: 'summary', summary: summary() })).toMatchObject({
      status: 'done',
      summary: summary(),
    });
    expect(applyHealthEvent(data, { type: 'summary', summary: summary({ cancelled: true }) }).status).toBe(
      'cancelled',
    );
    expect(applyHealthEvent(data, { type: 'snapshot', snapshot: 56 }).snapshot).toBe(56);
    expect(applyHealthEvent(data, { type: 'failed', message: 'The connection is closed.' })).toMatchObject({
      status: 'failed',
      message: 'The connection is closed.',
    });
  });

  it('has one panel key for the lake and one for each table of a connection', () => {
    const keys = [
      healthKey('a', lake),
      healthKey('a', events),
      healthKey('a', customers),
      healthKey('b', lake),
    ];
    expect(new Set(keys).size).toBe(4);
    expect(healthKey('a', events)).toBe(healthKey('a', { ...events, name: 'renamed' }));
  });
});

describe('the list of findings', () => {
  const all = [
    sampleFinding('storage.file-orphaned', 'info', lake, { object: 'a', objectKey: 's3://b/stray.parquet' }),
    sampleFinding('catalog.small-files', 'warning', events, { object: 'table:3' }),
    sampleFinding('storage.file-missing', 'error', customers, {
      object: 'data:7',
      title: 'A file is missing',
      objectKey: 's3://b/customers/one.parquet',
    }),
    sampleFinding('catalog.cleanup-overdue', 'warning', lake),
    sampleFinding('connection.store-access-denied', 'error', lake),
  ];

  it('sorts by group, severity and check, filters by severity, group and text, and groups into sections', () => {
    const ids = (change: object) =>
      matchingFindings(all, { ...DEFAULT_FILTER, ...change }).map(({ id }) => id);
    expect(ids({})).toEqual([
      'catalog.cleanup-overdue',
      'catalog.small-files:table:3',
      'connection.store-access-denied',
      'storage.file-missing:data:7',
      'storage.file-orphaned:a',
    ]);
    const cases: [string, object, string[]][] = [
      [
        'only errors',
        { severities: ['error'] },
        ['connection.store-access-denied', 'storage.file-missing:data:7'],
      ],
      ['storage group', { groups: ['storage'] }, ['storage.file-missing:data:7', 'storage.file-orphaned:a']],
      ['no severity', { severities: [] }, []],
      ['text in title, any case', { text: ' A FILE IS MISSING ' }, ['storage.file-missing:data:7']],
      ['text in object key', { text: 'stray.parquet' }, ['storage.file-orphaned:a']],
      ['text in table name', { text: 'shop.events' }, ['catalog.small-files:table:3']],
      ['text in check id', { text: 'cleanup-overdue' }, ['catalog.cleanup-overdue']],
      ['no match', { text: 'zebra' }, []],
    ];
    for (const [name, change, expected] of cases) {
      expect(ids(change), name).toEqual(expected);
    }
    expect(sections(matchingFindings(all, DEFAULT_FILTER)).map(({ findings }) => findings.length)).toEqual([
      3, 1, 1,
    ]);
    expect(counts(all)).toEqual({
      severity: { error: 2, warning: 2, info: 1 },
      group: { catalog: 2, connection: 1, storage: 2, deep: 0 },
    });
  });
});

describe('the verdict and the key figures', () => {
  const finished = (changes: Partial<HealthData> = {}): HealthData => ({
    ...freshData('Lake', lake, choice, 'running'),
    status: 'done',
    groups: [
      done('catalog'),
      done('connection'),
      done('storage'),
      { group: 'deep', state: 'skipped', reason: 'Not part of the quick check.' },
    ],
    summary: summary(),
    ...changes,
  });
  const info = sampleFinding('catalog.cleanup-pending', 'info', lake);
  const error = sampleFinding('storage.file-missing', 'error', events, { object: 'data:1' });

  it('is idle, running, failed, healthy, problems or incomplete as the run and its findings say', () => {
    const cases: [string, Partial<HealthData>, string][] = [
      ['has not run', { status: 'idle' }, 'idle'],
      ['is running', { status: 'running' }, 'running'],
      ['could not start', { status: 'failed', message: 'closed' }, 'failed'],
      ['found nothing', {}, 'healthy'],
      ['found only infos', { findings: [info] }, 'healthy'],
      ['found an error and an info', { findings: [error, info] }, 'problems'],
      ['was cancelled without a finding', { status: 'cancelled' }, 'incomplete'],
      ['was cancelled with an error', { status: 'cancelled', findings: [error] }, 'problems'],
      [
        'had a failed group',
        { groups: [done('catalog'), { group: 'storage', state: 'failed', message: 'x' }] },
        'incomplete',
      ],
    ];
    for (const [name, change, expected] of cases) {
      expect(verdict(finished(change)), name).toBe(expected);
    }
  });

  it('has no cards before the summary, then counts, time, snapshot and the not-checked total', () => {
    expect(healthCards(freshData('Lake', lake, choice, 'running'))).toEqual([]);
    const data = finished({
      snapshot: 56,
      groups: [done('storage', { truncated: true, notChecked: 40 }), done('deep', { notChecked: 3 })],
      summary: summary({ errors: 2, warnings: 1, infos: 4, omitted: 20 }),
    });
    expect(healthCards(data).map(({ value, severity }) => [value, severity])).toEqual([
      ['2', 'error'],
      ['1', 'warning'],
      ['4', 'ok'],
      ['1.5 s', 'ok'],
      ['@56', 'ok'],
      ['63', 'warning'],
    ]);
    expect(healthCards(finished()).map(({ value, severity }) => [value, severity])).toEqual([
      ['0', 'ok'],
      ['0', 'ok'],
      ['0', 'ok'],
      ['1.5 s', 'ok'],
      ['not read', 'ok'],
      ['0', 'ok'],
    ]);
  });
});

describe('the actions of a finding', () => {
  it('offers the evidence, the setting, the table and the endpoint when the finding has them', () => {
    const finding = sampleFinding('connection.url-style-vhost-ip', 'warning', lake, {
      inspectSql: 'SELECT 1',
      settingKey: 's3.urlStyle',
    });
    expect(actionsOf(finding)).toEqual(['inspect', 'setting']);
    expect(actionsOf({ ...finding, scope: events })).toEqual([
      'inspect',
      'setting',
      'revealTable',
      'showStatistics',
    ]);
    expect(actionsOf(sampleFinding('catalog.snapshot-gaps', 'info', lake))).toEqual([]);
    const notSet = sampleFinding('connection.endpoint-not-set', 'error', lake, {
      settingKey: 's3.endpoint',
      suggestion: { endpoint: 'http://rustfs:9000', urlStyle: 'path', source: 'AWS_ENDPOINT_URL_S3' },
    });
    expect(actionsOf(notSet)).toEqual(['useEndpoint', 'setCredentials', 'setting']);
    expect(actionsOf({ ...notSet, suggestion: undefined })).toEqual(['setCredentials', 'setting']);
    expect(actionsOf(sampleFinding('connection.credentials-missing', 'warning', lake))).toEqual([
      'setCredentials',
    ]);
    expect(actionsOf(sampleFinding('connection.store-bucket-missing', 'error', lake))).toEqual([]);
  });

  it('answers only the maintainable checks with a maintenance script, and a table script only for a table', () => {
    const scripts = [
      ['catalog.cleanup-overdue', lake, 'cleanup'],
      ['catalog.cleanup-pending', lake, 'cleanup'],
      ['catalog.many-snapshots', lake, 'expire'],
      ['catalog.small-files', events, 'merge'],
      ['catalog.large-inlined-data', events, 'flush'],
      ['storage.file-orphaned', lake, 'orphans'],
    ] as const;
    for (const [check, scope, kind] of scripts) {
      const finding = sampleFinding(check, 'info', scope);
      expect(healthScriptOf(finding)?.kind, check).toBe(kind);
      expect(actionsOf(finding), check).toContain('script');
    }
    expect(healthScriptOf(sampleFinding('catalog.small-files', 'info', lake))).toBeUndefined();
    const withScript = new Set<string>(scripts.map(([check]) => check));
    for (const check of Object.keys(CHECKS) as (keyof typeof CHECKS)[]) {
      if (!withScript.has(check)) {
        expect(healthScriptOf(sampleFinding(check, 'error', events)), check).toBeUndefined();
      }
    }
  });
});

describe.skipIf(await engineSkipReason())('the data of a real run', () => {
  it('holds the findings of the report once the events are applied, and lists them in the order of the report', async () => {
    const data = await runOnHistory(breakHistory, 'deep');
    expect(data.findings.map(({ id }) => id).toSorted()).toEqual([
      'catalog.cleanup-pending',
      'catalog.negative-counts',
      'catalog.small-files:table:3',
      'storage.file-missing:data:0',
    ]);
    expect(matchingFindings(data.findings, DEFAULT_FILTER).map(({ id }) => id)).toEqual([
      'catalog.negative-counts',
      'catalog.cleanup-pending',
      'catalog.small-files:table:3',
      'storage.file-missing:data:0',
    ]);
    expect(data).toMatchObject({ status: 'done', snapshot: 56 });
  });
});
