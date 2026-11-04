import { describe, expect, it } from 'vitest';
import { endpointQuestion, planHealthAction } from '../../src/health-report/actions';
import { healthKind } from '../../src/health-report/kind';
import { MAX_DEEP_FILES, applyEvents, freshData } from '../../src/health-report/model';
import type { HealthData } from '../../src/health-report/model';
import { isHealthAction, isHealthMessage, isHealthView, isWholeData } from '../../src/health-report/protocol';
import type { HealthAction } from '../../src/health-report/protocol';
import { isShellRequest } from '../../src/shell/protocol';
import { customers, events, sampleFinding } from './health-report-support';

const lake = { kind: 'lake' } as const;
const choice = { depth: 'quick', deepFiles: 200 } as const;

/** What a webview message is after the trip through JSON. */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

const orphan = sampleFinding('storage.file-orphaned', 'info', lake, {
  object: 'a',
  objectKey: 's3://b/x.parquet',
  inspectSql: 'SELECT 1',
});
const small = sampleFinding('catalog.small-files', 'warning', events, { object: 'table:3' });
const setting = sampleFinding('connection.endpoint-with-path', 'warning', lake, {
  settingKey: 's3.endpoint',
});
const plain = sampleFinding('catalog.snapshot-gaps', 'info', lake);

const data = (status: HealthData['status'] = 'done'): HealthData => ({
  ...applyEvents(freshData('Lake', lake, choice, 'running'), [
    {
      type: 'group',
      status: { group: 'catalog', state: 'done', truncated: true, omitted: 3, notChecked: 1 },
    },
    { type: 'progress', group: 'deep', done: 1, total: 2 },
    { type: 'finding', finding: orphan },
    { type: 'finding', finding: small },
    { type: 'finding', finding: setting },
    { type: 'finding', finding: plain },
    {
      type: 'summary',
      summary: { errors: 0, warnings: 2, infos: 2, omitted: 3, elapsedMs: 10, cancelled: false },
    },
    { type: 'snapshot', snapshot: 56 },
  ]),
  status,
});

describe('the data that the Health page accepts', () => {
  it('accepts the state of the check of a schema', () => {
    const schema = { ...data(), scope: { kind: 'schema', id: 2, name: 'shop' } } as const;

    expect(isHealthMessage(wire({ type: 'health', data: schema }))).toBe(true);
  });

  it('accepts the state of a run, an idle panel and a failed start, after the trip through JSON', () => {
    expect(isHealthMessage(wire({ type: 'health', data: data() }))).toBe(true);
    expect(isHealthMessage(wire({ type: 'health', data: freshData('Lake', events, choice, 'idle') }))).toBe(
      true,
    );
    expect(
      isHealthMessage(
        wire({
          type: 'health',
          data: { ...freshData('Lake', lake, choice, 'running'), status: 'failed', message: 'x' },
        }),
      ),
    ).toBe(true);
  });

  it('accepts a batch of every kind of event, and tells it from the whole state', () => {
    const message = wire({
      type: 'health',
      data: {
        events: [
          { type: 'group', status: { group: 'storage', state: 'skipped', reason: 'x' } },
          { type: 'progress', group: 'deep', done: 0, total: 10 },
          { type: 'finding', finding: orphan },
          {
            type: 'summary',
            summary: { errors: 0, warnings: 0, infos: 1, omitted: 0, elapsedMs: 3, cancelled: true },
          },
          { type: 'snapshot', snapshot: 4 },
          { type: 'failed', message: 'x' },
        ],
      },
    });
    expect(isHealthMessage(message)).toBe(true);
    const { data: sent } = message as { data: Parameters<typeof isWholeData>[0] };
    expect(isWholeData(sent)).toBe(false);
    expect(isWholeData(data())).toBe(true);
  });

  it('rejects a whole state with a field that is missing or malformed', () => {
    const rows: [string, (value: HealthData) => unknown][] = [
      ['a missing connection', ({ connection: _c, ...rest }) => rest],
      ['a depth that is no depth', (value) => ({ ...value, depth: 'full' })],
      ['a number of files of zero', (value) => ({ ...value, deepFiles: 0 })],
      ['a number of files over the cap', (value) => ({ ...value, deepFiles: MAX_DEEP_FILES + 1 })],
      ['a number of files as a fraction', (value) => ({ ...value, deepFiles: 1.5 })],
      ['a status that is none', (value) => ({ ...value, status: 'paused' })],
      [
        'a scope of a table without a name',
        (value) => ({ ...value, scope: { kind: 'table', id: 1, schema: 's' } }),
      ],
      ['a scope of a schema without a name', (value) => ({ ...value, scope: { kind: 'schema', id: 1 } })],
      ['a scope of another kind', (value) => ({ ...value, scope: { kind: 'view' } })],
      ['findings that are no list', (value) => ({ ...value, findings: 'many' })],
      [
        'a finding of a check that does not exist',
        (value) => ({ ...value, findings: [{ ...orphan, check: 'x.y' }] }),
      ],
      [
        'a finding of an inherited check name',
        (value) => ({ ...value, findings: [{ ...orphan, check: 'toString' }] }),
      ],
      [
        'a finding with a severity that is none',
        (value) => ({ ...value, findings: [{ ...orphan, severity: 'fatal' }] }),
      ],
      ['a finding without a title', (value) => ({ ...value, findings: [{ ...orphan, title: undefined }] })],
      ['a finding with SQL as a number', (value) => ({ ...value, findings: [{ ...orphan, inspectSql: 7 }] })],
      [
        'a group in a state that is none',
        (value) => ({ ...value, groups: [{ group: 'catalog', state: 'paused' }] }),
      ],
      ['a group that does not exist', (value) => ({ ...value, groups: [{ group: 'cloud', state: 'done' }] })],
      [
        'a truncated flag of false',
        (value) => ({ ...value, groups: [{ group: 'catalog', state: 'done', truncated: false }] }),
      ],
      [
        'a summary with a count as text',
        (value) => ({ ...value, summary: { ...value.summary, errors: '0' } }),
      ],
      ['progress without a total', (value) => ({ ...value, progress: { group: 'deep', done: 1 } })],
      ['a snapshot as text', (value) => ({ ...value, snapshot: '56' })],
      ['a finding without an id', (value) => ({ ...value, findings: [{ ...orphan, id: undefined }] })],
      [
        'a finding of a group that is none',
        (value) => ({ ...value, findings: [{ ...orphan, group: 'cloud' }] }),
      ],
      [
        'a finding with a scope that is none',
        (value) => ({ ...value, findings: [{ ...orphan, scope: { kind: 'schema' } }] }),
      ],
      ['a finding without a detail', (value) => ({ ...value, findings: [{ ...orphan, detail: undefined }] })],
      ['a finding without a cause', (value) => ({ ...value, findings: [{ ...orphan, cause: undefined }] })],
      ['a finding without a fix', (value) => ({ ...value, findings: [{ ...orphan, fix: undefined }] })],
      [
        'a group with a reason as a number',
        (value) => ({ ...value, groups: [{ group: 'storage', state: 'skipped', reason: 7 }] }),
      ],
      [
        'a group with a message as a number',
        (value) => ({ ...value, groups: [{ group: 'storage', state: 'failed', message: 7 }] }),
      ],
      [
        'a summary with the time as text',
        (value) => ({ ...value, summary: { ...value.summary, elapsedMs: '10' } }),
      ],
      [
        'a summary whose cancelled is no boolean',
        (value) => ({ ...value, summary: { ...value.summary, cancelled: 'no' } }),
      ],
      [
        'progress with a count as text',
        (value) => ({ ...value, progress: { group: 'deep', done: '1', total: 2 } }),
      ],
      [
        'progress of a group that does not exist',
        (value) => ({ ...value, progress: { group: 'cloud', done: 1, total: 2 } }),
      ],
    ];
    for (const [name, change] of rows) {
      expect(isHealthMessage(wire({ type: 'health', data: change(data()) })), name).toBe(false);
    }
  });

  it('rejects a batch of events with a broken event', () => {
    const rows: [string, unknown][] = [
      ['an event of a type that is none', { events: [{ type: 'pause' }] }],
      ['an event that is no object', { events: ['group'] }],
      ['a finding event with a broken finding', { events: [{ type: 'finding', finding: { id: 'x' } }] }],
      ['a group event without its status', { events: [{ type: 'group' }] }],
      ['a batch next to other fields', { events: [], status: 'done' }],
      ['events that are no list', { events: 'none' }],
      [
        'a progress event with a count as text',
        { events: [{ type: 'progress', group: 'deep', done: '1', total: 2 }] },
      ],
      [
        'a progress event of a group that does not exist',
        { events: [{ type: 'progress', group: 'cloud', done: 1, total: 2 }] },
      ],
      [
        'a summary event with the time as text',
        {
          events: [
            {
              type: 'summary',
              summary: { errors: 0, warnings: 0, infos: 0, omitted: 0, elapsedMs: '3', cancelled: false },
            },
          ],
        },
      ],
      ['a snapshot event with text', { events: [{ type: 'snapshot', snapshot: '4' }] }],
      ['a failed event without a text', { events: [{ type: 'failed', message: 4 }] }],
    ];
    for (const [name, batch] of rows) {
      expect(isHealthMessage(wire({ type: 'health', data: batch })), name).toBe(false);
    }
    for (const value of [
      null,
      undefined,
      'health',
      7,
      [],
      {},
      { type: 'storage', data: {} },
      { type: 'health' },
    ]) {
      expect(isHealthMessage(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('what the extension accepts from the Health page', () => {
  it('accepts the actions of the page, runs at both ends of the file range', () => {
    const rows: [string, unknown][] = [
      ['a run, quick', { type: 'action', action: 'run', depth: 'quick', deepFiles: 200 }],
      [
        'a run, deep with the smallest number of files',
        { type: 'action', action: 'run', depth: 'deep', deepFiles: 1 },
      ],
      [
        'a run, deep with the largest',
        { type: 'action', action: 'run', depth: 'deep', deepFiles: MAX_DEEP_FILES },
      ],
      ['a cancel', { type: 'action', action: 'cancel' }],
      ['the script for all findings', { type: 'action', action: 'maintenanceScript' }],
      ['opening the SQL of a finding', { type: 'action', action: 'inspect', finding: 'a' }],
      ['opening a setting', { type: 'action', action: 'setting', finding: 'a' }],
      ['opening a script', { type: 'action', action: 'script', finding: 'a' }],
      ['using the suggested endpoint', { type: 'action', action: 'useEndpoint', finding: 'a' }],
      ['setting the S3 credentials', { type: 'action', action: 'setCredentials', finding: 'a' }],
      ['showing a table', { type: 'action', action: 'revealTable', finding: 'a' }],
      ['showing the statistics', { type: 'action', action: 'showStatistics', finding: 'a' }],
    ];
    for (const [name, message] of rows) {
      expect(isHealthAction(wire(message)), name).toBe(true);
    }
  });

  it('rejects undeclared actions, malformed runs and fields the page may not send', () => {
    const rows: [string, unknown][] = [
      ['an action that nobody declared', { type: 'action', action: 'deleteOrphans', finding: 'a' }],
      ['an action named like a method of every object', { type: 'action', action: 'toString' }],
      ['a command id', { type: 'action', action: 'workbench.action.openSettings', finding: 'a' }],
      ['a run without a depth', { type: 'action', action: 'run', deepFiles: 200 }],
      ['a run with a depth that is none', { type: 'action', action: 'run', depth: 'full', deepFiles: 200 }],
      ['a run without the number of files', { type: 'action', action: 'run', depth: 'deep' }],
      ['a run with no file', { type: 'action', action: 'run', depth: 'deep', deepFiles: 0 }],
      [
        'a run with a negative number of files',
        { type: 'action', action: 'run', depth: 'deep', deepFiles: -1 },
      ],
      ['a run with a fraction of files', { type: 'action', action: 'run', depth: 'deep', deepFiles: 2.5 }],
      [
        'a run with too many files',
        { type: 'action', action: 'run', depth: 'deep', deepFiles: MAX_DEEP_FILES + 1 },
      ],
      [
        'a run with the number of files as text',
        { type: 'action', action: 'run', depth: 'deep', deepFiles: '200' },
      ],
      [
        'a run with a field of its own',
        { type: 'action', action: 'run', depth: 'quick', deepFiles: 1, limits: {} },
      ],
      ['a cancel with a field', { type: 'action', action: 'cancel', finding: 'a' }],
      ['an action of a finding without the finding', { type: 'action', action: 'inspect' }],
      ['an action of a finding with a number', { type: 'action', action: 'inspect', finding: 3 }],
      [
        'an action of a finding with SQL of its own',
        { type: 'action', action: 'inspect', finding: 'a', sql: 'DROP TABLE x' },
      ],
      [
        'an action of a finding with a setting of its own',
        { type: 'action', action: 'setting', finding: 'a', key: 'x' },
      ],
      ['a message of another type', { type: 'run', action: 'cancel' }],
      [
        'using an endpoint of its own',
        { type: 'action', action: 'useEndpoint', finding: 'a', endpoint: 'http://evil:9000' },
      ],
      ['credentials without a finding', { type: 'action', action: 'setCredentials' }],
      [
        'credentials sent from the page',
        { type: 'action', action: 'setCredentials', finding: 'a', keyId: 'AKIA', secretKey: 's' },
      ],
      [
        'the command of the credentials as the action',
        { type: 'action', action: 'aantje.setS3Credentials', finding: 'a' },
      ],
    ];
    for (const [name, message] of rows) {
      expect(isHealthAction(wire(message)), name).toBe(false);
    }
    // The action is not read from the prototype of the message.
    expect(
      isHealthAction(Object.assign(Object.create({ action: 'cancel' }) as object, { type: 'action' })),
    ).toBe(false);
  });

  it('accepts the filter of the page with Open as Markdown and nothing else, with the same guards in the kind', () => {
    const view = { text: 'orders', severities: ['error', 'warning'], groups: ['storage'] };
    expect(isHealthView(view)).toBe(true);
    expect(isShellRequest({ type: 'markdown', view }, isHealthView)).toBe(true);
    for (const bad of [
      { ...view, severities: ['fatal'] },
      { ...view, groups: ['cloud'] },
      { ...view, text: 7 },
      { text: 'x', severities: [] },
      'orders',
    ]) {
      expect(isHealthView(bad)).toBe(false);
    }
    expect(healthKind.viewType).toBe('aantje.health');
    expect(healthKind.message(data())).toEqual({ type: 'health', data: data() });
    expect(healthKind.isAction?.({ type: 'action', action: 'cancel' })).toBe(true);
    expect(healthKind.isAction?.({ type: 'action', action: 'refresh' })).toBe(false);
  });
});

describe('what a request from the page is planned as', () => {
  const act = (message: Partial<HealthAction> & Pick<HealthAction, 'action'>): HealthAction => ({
    type: 'action',
    ...message,
  });
  const running = (): HealthData => ({ ...data(), status: 'running' });
  const withTable: HealthData = {
    ...data(),
    findings: [
      ...data().findings,
      sampleFinding('catalog.large-inlined-data', 'info', customers, {
        object: 'table:4',
        inspectSql: 'SELECT 2',
      }),
    ],
  };

  it('runs with the choice of the page when no run is going', () => {
    expect(planHealthAction(data(), act({ action: 'run', depth: 'deep', deepFiles: 50 }))).toEqual({
      action: 'run',
      depth: 'deep',
      deepFiles: 50,
    });
    expect(
      planHealthAction(
        freshData('Lake', lake, choice, 'idle'),
        act({ action: 'run', depth: 'quick', deepFiles: 200 }),
      ),
    ).toMatchObject({
      action: 'run',
    });
  });

  it('refuses a second run while one is going, and a cancel while none is', () => {
    expect(
      planHealthAction(running(), act({ action: 'run', depth: 'quick', deepFiles: 200 })),
    ).toBeUndefined();
    expect(planHealthAction(running(), act({ action: 'cancel' }))).toEqual({ action: 'cancel' });
    expect(planHealthAction(data(), act({ action: 'cancel' }))).toBeUndefined();
  });

  it('plans the script for all findings from the data, and only when nothing runs and a finding has a script', () => {
    const plan = planHealthAction(data(), act({ action: 'maintenanceScript' }));

    expect(plan).toMatchObject({ action: 'maintenanceScript' });
    expect(plan?.action === 'maintenanceScript' && plan.text).toContain('ducklake_delete_orphaned_files');
    expect(planHealthAction(running(), act({ action: 'maintenanceScript' }))).toBeUndefined();
    expect(
      planHealthAction({ ...data(), findings: [setting, plain] }, act({ action: 'maintenanceScript' })),
    ).toBeUndefined();
  });

  it('plans the actions of a finding from the finding that the extension sent', () => {
    expect(planHealthAction(data(), act({ action: 'inspect', finding: orphan.id }))).toEqual({
      action: 'inspect',
      sql: 'SELECT 1',
    });
    expect(planHealthAction(data(), act({ action: 'setting', finding: setting.id }))).toEqual({
      action: 'setting',
      key: 's3.endpoint',
    });
    expect(planHealthAction(data(), act({ action: 'script', finding: orphan.id }))).toEqual({
      action: 'script',
      kind: 'orphans',
    });
    expect(planHealthAction(data(), act({ action: 'script', finding: small.id }))).toEqual({
      action: 'script',
      kind: 'merge',
      table: { id: 3, schema: 'shop', name: 'events' },
    });
    // A script for the lake does not name the table of the finding that offers it.
    const ofTable = sampleFinding('storage.file-orphaned', 'info', events, { object: 'in-table' });
    expect(
      planHealthAction(
        applyEvents(data(), [{ type: 'finding', finding: ofTable }]),
        act({ action: 'script', finding: ofTable.id }),
      ),
    ).toEqual({ action: 'script', kind: 'orphans' });
    expect(planHealthAction(data(), act({ action: 'revealTable', finding: small.id }))).toEqual({
      action: 'revealTable',
      table: { id: 3, schema: 'shop', name: 'events' },
    });
    expect(
      planHealthAction(
        withTable,
        act({ action: 'showStatistics', finding: 'catalog.large-inlined-data:table:4' }),
      ),
    ).toEqual({
      action: 'showStatistics',
      table: { id: 4, schema: 'shop', name: 'customers' },
    });
  });

  it('plans nothing for a finding that was not sent, or an action that the finding does not offer', () => {
    expect(planHealthAction(data(), act({ action: 'inspect', finding: 'made.up:1' }))).toBeUndefined();
    expect(planHealthAction(data(), act({ action: 'inspect', finding: setting.id }))).toBeUndefined();
    expect(planHealthAction(data(), act({ action: 'setting', finding: orphan.id }))).toBeUndefined();
    expect(planHealthAction(data(), act({ action: 'revealTable', finding: orphan.id }))).toBeUndefined();
    expect(planHealthAction(data(), act({ action: 'showStatistics', finding: plain.id }))).toBeUndefined();
    expect(planHealthAction(data(), act({ action: 'script', finding: plain.id }))).toBeUndefined();
    expect(planHealthAction(data(), act({ action: 'inspect' }))).toBeUndefined();
  });
});

describe('the actions that change the setup', () => {
  const suggestion = {
    endpoint: 'http://rustfs:9000',
    urlStyle: 'path',
    source: 'AWS_ENDPOINT_URL_S3',
  } as const;
  const notSet = sampleFinding('connection.endpoint-not-set', 'error', lake, {
    settingKey: 's3.endpoint',
    suggestion,
  });
  const notSetBare = sampleFinding('connection.endpoint-not-set', 'warning', lake, {
    settingKey: 's3.endpoint',
    object: 'bare',
  });
  const missing = sampleFinding('connection.credentials-missing', 'warning', lake);
  const denied = sampleFinding('connection.store-access-denied', 'error', lake, {
    settingKey: 's3.endpoint',
  });
  const bucket = sampleFinding('connection.store-bucket-missing', 'error', lake, {
    settingKey: 's3.endpoint',
  });
  const state = (status: HealthData['status'] = 'done'): HealthData => ({
    ...applyEvents(
      freshData('Lake', lake, choice, 'running'),
      [notSet, notSetBare, missing, denied, bucket].map((finding) => ({ type: 'finding' as const, finding })),
    ),
    status,
  });
  const act = (action: 'useEndpoint' | 'setCredentials' | 'setting', finding: string): HealthAction => ({
    type: 'action',
    action,
    finding,
  });

  it('carries the suggestion of a finding through the page and back, and rejects a malformed one', () => {
    expect(isHealthMessage(wire({ type: 'health', data: state() }))).toBe(true);
    for (const bad of [
      { endpoint: 1, source: 'X' },
      { endpoint: 'http://a:1', urlStyle: 'vhost', source: 'X' },
      { endpoint: 'http://a:1' },
      'http://a:1',
    ]) {
      const wrong = { ...notSet, suggestion: bad };
      expect(isHealthMessage(wire({ type: 'health', data: { ...state(), findings: [wrong] } }))).toBe(false);
    }
  });

  it('plans the endpoint from the suggestion of the finding that the extension sent', () => {
    expect(planHealthAction(state(), act('useEndpoint', notSet.id))).toEqual({
      action: 'useEndpoint',
      endpoint: 'http://rustfs:9000',
      urlStyle: 'path',
      source: 'AWS_ENDPOINT_URL_S3',
    });
  });

  it('plans the endpoint without a URL style when none is suggested', () => {
    const aws = sampleFinding('connection.endpoint-not-set', 'error', lake, {
      object: 'aws',
      suggestion: { endpoint: 'https://s3.eu-west-1.amazonaws.com', source: 'AWS_ENDPOINT_URL' },
    });
    const withAws = applyEvents(state(), [{ type: 'finding', finding: aws }]);

    expect(planHealthAction(withAws, act('useEndpoint', aws.id))).toEqual({
      action: 'useEndpoint',
      endpoint: 'https://s3.eu-west-1.amazonaws.com',
      source: 'AWS_ENDPOINT_URL',
    });
  });

  it('offers the endpoint only for the finding that has a suggestion', () => {
    expect(planHealthAction(state(), act('useEndpoint', notSetBare.id))).toBeUndefined();
    for (const other of [missing, denied, bucket]) {
      expect(planHealthAction(state(), act('useEndpoint', other.id))).toBeUndefined();
    }
    expect(planHealthAction(state(), act('useEndpoint', 'made.up:1'))).toBeUndefined();
    // A suggestion is only honoured on the finding of its own check.
    const forged = sampleFinding('connection.store-bucket-missing', 'error', lake, {
      object: 'forged',
      suggestion,
    });
    const withForged = applyEvents(state(), [{ type: 'finding', finding: forged }]);
    expect(planHealthAction(withForged, act('useEndpoint', forged.id))).toBeUndefined();
  });

  it('offers the credentials for a missing credential, a refusal and an endpoint that is not set, and for nothing else', () => {
    for (const offered of [missing, denied, notSet, notSetBare]) {
      expect(planHealthAction(state(), act('setCredentials', offered.id)), offered.id).toEqual({
        action: 'setCredentials',
      });
    }
    expect(planHealthAction(state(), act('setCredentials', bucket.id))).toBeUndefined();
    expect(planHealthAction(state(), act('setCredentials', 'made.up:1'))).toBeUndefined();
  });

  it('plans neither while a check is running, so that a write never changes what the run reads', () => {
    expect(planHealthAction(state('running'), act('useEndpoint', notSet.id))).toBeUndefined();
    expect(planHealthAction(state('running'), act('setCredentials', missing.id))).toBeUndefined();
    expect(planHealthAction(state('running'), act('setting', notSet.id))).toEqual({
      action: 'setting',
      key: 's3.endpoint',
    });
  });

  it('asks in one question that names the endpoint, the URL style when there is one, and the variable', () => {
    const withStyle = endpointQuestion({
      action: 'useEndpoint',
      endpoint: 'http://rustfs:9000',
      urlStyle: 'path',
      source: 'AWS_ENDPOINT_URL_S3',
    });
    expect(withStyle.message).toContain('http://rustfs:9000');
    expect(withStyle.message).toContain('path');
    expect(withStyle.detail).toContain('AWS_ENDPOINT_URL_S3');
    const without = endpointQuestion({
      action: 'useEndpoint',
      endpoint: 'https://s3.eu-west-1.amazonaws.com',
      source: 'AWS_ENDPOINT_URL',
    });
    expect(without.message).toContain('https://s3.eu-west-1.amazonaws.com');
    expect(without.message).not.toContain('urlStyle');
  });
});
