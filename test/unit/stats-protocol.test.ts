import { describe, expect, it } from 'vitest';
import { isStatisticsMessage } from '../../src/stats/protocol';
import { historyStatistics } from './stats-support';

const all = await historyStatistics();

/** What the page gets: a message that went through JSON like a `postMessage` does. */
const message = (statistics: unknown) =>
  JSON.parse(
    JSON.stringify({ type: 'statistics', data: { table: 'shop.events', connection: 'History', statistics } }),
  ) as unknown;

describe('isStatisticsMessage', () => {
  it('accepts the real statistics after a trip through JSON, with and without the optional parts', () => {
    for (const name of ['events', 'eventsAtYear', 'customers', 'notes', 'log', 'logMerged'] as const) {
      expect(isStatisticsMessage(message(all[name])), name).toBe(true);
    }
    expect(
      isStatisticsMessage(
        message({ ...all.events, approximate: true, columnsPartial: true, growthMerged: true }),
      ),
    ).toBe(true);
    const { partitioning: _removed, ...withoutPartitioning } = all.events;
    expect(isStatisticsMessage(message(withoutPartitioning))).toBe(true);
  });

  it('rejects broken statistics', () => {
    const broken: [string, (statistics: Record<string, unknown>) => Record<string, unknown>][] = [
      ['a negative count', (s) => ({ ...s, files: -1 })],
      ['a fraction as a count', (s) => ({ ...s, rows: 1.5 })],
      ['a count as text', (s) => ({ ...s, dataBytes: '10' })],
      ['a missing field', ({ growth: _growth, ...rest }) => rest],
      ['approximate that is false', (s) => ({ ...s, approximate: false })],
      ['a histogram that is no list', (s) => ({ ...s, sizeHistogram: {} })],
      ['a bin without files', (s) => ({ ...s, sizeHistogram: [{ fromBytes: 0, toBytes: 1, sizeBytes: 0 }] })],
      [
        'a null share above 1',
        (s) => ({
          ...s,
          columns: [{ id: 1, path: ['a'], type: 'x', nullable: true, nullRatio: 1.5, min: null, max: null }],
        }),
      ],
      [
        'a column path of numbers',
        (s) => ({
          ...s,
          columns: [{ id: 1, path: [1], type: 'x', nullable: true, nullRatio: null, min: null, max: null }],
        }),
      ],
      [
        'a partition value that is a number',
        (s) => ({
          ...s,
          partitioning: {
            ...(s.partitioning as object),
            partitions: [{ values: [1], files: 1, sizeBytes: 1, rows: 1 }],
          },
        }),
      ],
      [
        'an evenness that is not a number',
        (s) => ({
          ...s,
          partitioning: { ...(s.partitioning as object), evenness: { coefficientOfVariation: 'x', gini: 0 } },
        }),
      ],
      [
        'a growth point without a compaction flag',
        (s) => ({ ...s, growth: [{ snapshot: 1, time: null, files: 1, sizeBytes: 1 }] }),
      ],
    ];
    for (const [name, change] of broken) {
      expect(
        isStatisticsMessage(message(change(all.events as unknown as Record<string, unknown>))),
        name,
      ).toBe(false);
    }
  });

  it('rejects everything that is not a statistics message', () => {
    for (const value of [
      null,
      undefined,
      'statistics',
      42,
      [],
      {},
      { type: 'statistics' },
      { type: 'statistics', data: null },
      { type: 'statistics', data: { table: 'a', connection: 'b' } },
      { type: 'data', data: { table: 'a', connection: 'b', statistics: all.events } },
      { type: 'statistics', data: { table: 1, connection: 'b', statistics: all.events } },
    ]) {
      expect(isStatisticsMessage(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('isStatisticsMessage, field by field', () => {
  /** Every optional part present, so that each field below has something to lose. */
  const full = () => {
    const { partitioning, ...rest } = all.events;
    return message({
      ...rest,
      approximate: true,
      columnsPartial: true,
      growthMerged: true,
      partitioning: {
        ...partitioning,
        rest: { partitions: 2, files: 3, sizeBytes: 4, rows: 5 },
        partial: true,
      },
    }) as { data: Record<string, unknown> };
  };

  /** A copy of the message with the value at `path` replaced, or removed when `replacement` is `undefined`. */
  function changed(path: string, replacement?: unknown): unknown {
    const root = full();
    const keys = path.split('.');
    const last = keys.pop() as string;
    const parent = keys.reduce<Record<string, unknown>>(
      (node, key) => node[key] as Record<string, unknown>,
      root as unknown as Record<string, unknown>,
    );
    if (replacement === undefined) {
      delete parent[last];
    } else {
      parent[last] = replacement;
    }
    return root;
  }

  const S = 'data.statistics';
  const required = [
    'data.table',
    'data.connection',
    ...[
      'snapshot',
      'rows',
      'files',
      'deleteFiles',
      'dataBytes',
      'deleteBytes',
      'largestFileBytes',
      'smallFiles',
      'smallFileBytes',
      'sizeHistogram',
      'sizeHistogram.0.fromBytes',
      'sizeHistogram.0.toBytes',
      'sizeHistogram.0.files',
      'sizeHistogram.0.sizeBytes',
      'partitioning.partitioning',
      'partitioning.partitioning.id',
      'partitioning.partitioning.beginSnapshot',
      'partitioning.partitioning.endSnapshot',
      'partitioning.partitioning.columns',
      'partitioning.partitioning.columns.0.columnId',
      'partitioning.partitioning.columns.0.path',
      'partitioning.partitioning.columns.0.transform',
      'partitioning.partitions',
      'partitioning.partitions.0.values',
      'partitioning.partitions.0.files',
      'partitioning.partitions.0.sizeBytes',
      'partitioning.partitions.0.rows',
      'partitioning.rest.partitions',
      'partitioning.rest.files',
      'partitioning.rest.sizeBytes',
      'partitioning.rest.rows',
      'partitioning.evenness',
      'partitioning.evenness.coefficientOfVariation',
      'partitioning.evenness.gini',
      'partitioning.earlierFiles',
      'columns',
      'columns.0.id',
      'columns.0.path',
      'columns.0.type',
      'columns.0.nullable',
      'columns.0.nullRatio',
      'columns.0.min',
      'columns.0.max',
      'growth',
      'growth.0.snapshot',
      'growth.0.time',
      'growth.0.files',
      'growth.0.sizeBytes',
      'growth.0.compaction',
    ].map((field) => `${S}.${field}`),
  ];

  it('accepts the message with all its optional parts, and without each of them', () => {
    expect(isStatisticsMessage(full())).toBe(true);
    for (const field of [
      'approximate',
      'columnsPartial',
      'growthMerged',
      'partitioning.rest',
      'partitioning.partial',
      'partitioning.keysLeftOut',
    ]) {
      expect(isStatisticsMessage(changed(`${S}.${field}`)), field).toBe(true);
    }
  });

  it('rejects a message without any one of its required fields', () => {
    for (const path of required) {
      expect(isStatisticsMessage(changed(path)), path).toBe(false);
    }
  });

  it('rejects a field set to a value of the wrong shape', () => {
    for (const [field, value] of [
      ['growthMerged', false],
      ['columnsPartial', 1],
      ['partitioning.partial', false],
      ['partitioning.keysLeftOut', -1],
      ['partitioning.keysLeftOut', '2'],
      ['partitioning.rest', 'x'],
      ['partitioning.rest.rows', -1],
      ['partitioning.evenness.gini', null],
      ['partitioning.evenness.coefficientOfVariation', null],
      ['columns.0.nullRatio', -0.1],
      ['columns.0.nullRatio', 'x'],
      ['columns.0.min', 5],
      ['growth.0.time', 5],
      ['growth.0.compaction', 'yes'],
      ['sizeHistogram.0.sizeBytes', 1.5],
      ['partitioning.earlierFiles', -1],
      ['partitioning.partitioning.endSnapshot', 'x'],
      ['partitioning.partitioning', []],
      ['partitioning', []],
      ['sizeHistogram.0', []],
      ['columns.0', []],
      ['growth.0', 'x'],
      ['', []],
    ] as const) {
      expect(
        isStatisticsMessage(changed(field === '' ? 'data.statistics' : `${S}.${field}`, value)),
        `${field} = ${JSON.stringify(value)}`,
      ).toBe(false);
    }
  });
});
