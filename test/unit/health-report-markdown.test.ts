import { describe, expect, it } from 'vitest';
import { healthMarkdown } from '../../src/health-report/markdown';
import { applyEvents, freshData } from '../../src/health-report/model';
import type { HealthData } from '../../src/health-report/model';
import { engineSkipReason } from './data-support';
import {
  breakHistory,
  customers,
  documentShape,
  events,
  runOnHistory,
  sampleFinding,
} from './health-report-support';

const MARKDOWN_FINDINGS = 200;

const lake = { kind: 'lake' } as const;
const choice = { depth: 'quick', deepFiles: 200 } as const;
const summary = { errors: 0, warnings: 0, infos: 0, omitted: 0, elapsedMs: 1500, cancelled: false };
const all = {
  text: '',
  severities: ['error', 'warning', 'info'],
  groups: ['catalog', 'connection', 'storage', 'deep'],
} as const;

describe.skipIf(await engineSkipReason())('the document of a real run', () => {
  it('holds the figures, the findings and the SQL of the history fixture, with what was checked and what was not', async () => {
    expect(documentShape(healthMarkdown(await runOnHistory()))).toEqual(HEALTHY_SHAPE);
  });

  it('holds the lost file and the negative count of a broken copy by severity and table, with the SQL to inspect them', async () => {
    expect(documentShape(healthMarkdown(await runOnHistory(breakHistory, 'deep')))).toEqual(BROKEN_SHAPE);
  });

  it('lists only the findings that the filter of the page keeps', async () => {
    const data = await runOnHistory(breakHistory, 'deep');
    const document = healthMarkdown(data, {
      ...all,
      severities: ['error'],
      groups: ['storage'],
      text: 'parquet',
    });

    expect(document).toContain('`storage.file-missing`');
    expect(document).not.toContain('catalog.negative-counts');
    expect(document).not.toContain('### Infos');
  });
});

describe('the document of a panel', () => {
  const running = (): HealthData => freshData('Lake', lake, choice, 'running');
  const textual = (raw: string): HealthData =>
    applyEvents(running(), [
      {
        type: 'finding',
        finding: sampleFinding('connection.local-path-missing', 'error', lake, {
          title: raw,
          detail: raw,
          cause: raw,
          fix: raw,
        }),
      },
    ]);

  it('renders idle, running and cancelled panels, and names tables by schema and name in their sections', () => {
    const idle = healthMarkdown(freshData('Lake', events, choice, 'idle'));
    expect(idle).toContain('`shop.events`');
    expect(idle).not.toContain('## What was checked');

    const live = healthMarkdown(
      applyEvents(running(), [
        { type: 'group', status: { group: 'catalog', state: 'done' } },
        { type: 'finding', finding: sampleFinding('catalog.snapshot-gaps', 'info', lake) },
      ]),
    );
    expect(live).toContain('## Groups');
    expect(live).toContain('**Title of catalog.snapshot-gaps**');

    const cancelled = healthMarkdown(
      applyEvents(running(), [
        { type: 'group', status: { group: 'catalog', state: 'done' } },
        { type: 'finding', finding: sampleFinding('catalog.cleanup-overdue', 'warning', lake) },
        { type: 'group', status: { group: 'storage', state: 'skipped', reason: 'Cancelled.' } },
        { type: 'summary', summary: { ...summary, warnings: 1, cancelled: true } },
      ]),
    );
    expect(cancelled).toContain('Storage: Cancelled.');

    const tables = applyEvents(running(), [
      {
        type: 'finding',
        finding: sampleFinding('catalog.small-files', 'info', customers, { object: 'table:4' }),
      },
      {
        type: 'finding',
        finding: sampleFinding('catalog.small-files', 'info', events, { object: 'table:3' }),
      },
      { type: 'finding', finding: sampleFinding('catalog.cleanup-pending', 'info', lake) },
    ]);
    expect(
      healthMarkdown(tables)
        .split('\n')
        .filter((line) => line.startsWith('#### ')),
    ).toEqual(['#### Lakehouse', '#### `shop.customers`', '#### `shop.events`']);
  });

  it('keeps hostile text from the catalog from rendering: no emphasis, link, tag, table cell, heading, or code fence', () => {
    const hostile =
      '**bold** _em_ [click](http://evil) ![img](http://evil) <script>alert(1)</script> | cell ~~gone~~ `code`';
    const data = applyEvents(running(), [
      {
        type: 'finding',
        finding: sampleFinding(
          'storage.file-missing',
          'error',
          { kind: 'table', id: 5, schema: 'sh`op', name: '# evil | table' },
          {
            object: 'data:1',
            title: hostile,
            detail: `${hostile}\n# not a heading\n- not a list`,
            objectKey: 's3://b/`k`|x\n```\nbreak',
            inspectSql: "SELECT '```'; -- ```\n```",
          },
        ),
      },
    ]);
    const lines = healthMarkdown(data).split('\n');

    expect(lines).toContain(
      String.raw`**\*\*bold\*\* \_em\_ \[click\](http\:\/\/evil) !\[img\](http\:\/\/evil) \<script\>alert(1)\</script\> \| cell \~\~gone\~\~ \`code\`**`,
    );
    expect(lines).toContain(
      String.raw`- Detail: \*\*bold\*\* \_em\_ \[click\](http\:\/\/evil) !\[img\](http\:\/\/evil) \<script\>alert(1)\</script\> \| cell \~\~gone\~\~ \`code\` # not a heading - not a list`,
    );
    // A name from the catalog is code on one line; a pipe in it is escaped and a backtick run never ends the span.
    expect(lines).toContain('#### ``sh`op.# evil \\| table``');
    expect(lines).toContain('- Object: ````s3://b/`k`\\|x ``` break````');
    // The SQL is a fenced block whose fence is longer than any run of backticks inside.
    const start = lines.indexOf('````sql');
    expect(lines.slice(start, start + 4)).toEqual(['````sql', "SELECT '```'; -- ```", '```', '````']);
    expect(lines.filter((line) => line.startsWith('#'))).toEqual([
      '# Health check of Lake',
      '## Groups',
      '## Findings',
      '### Errors (1)',
      '#### ``sh`op.# evil \\| table``',
    ]);
  });

  it('escapes addresses, list markers, backslashes and entities in every text, and leaves plain dashes, numbers and dots alone', () => {
    const rows: Array<[string, string, boolean]> = [
      [
        'data_path is "s3://bucket/www.phish.example/login", see https://phish.example/x?a=b and WWW.Phish.example, plain host.example.com and C:/data/lake stay readable',
        String.raw`data_path is "s3\:\/\/bucket/www\.phish.example/login", see https\:\/\/phish.example/x?a=b and WWW\.Phish.example, plain host.example.com and C:/data/lake stay readable`,
        true,
      ],
      ['mail root@evil.example now', String.raw`mail root\@evil.example now`, false],
      ['- item', String.raw`\- item`, false],
      ['+ item', String.raw`\+ item`, false],
      ['* item', String.raw`\* item`, false],
      ['1. item', String.raw`1\. item`, false],
      ['12) item', String.raw`12\) item`, false],
      ['# item', String.raw`\# item`, false],
      ['-', String.raw`\-`, false],
      ['well-known 2.5 files - and 3) more, a-b.c', 'well-known 2.5 files - and 3) more, a-b.c', false],
    ];
    for (const [raw, escaped, everyText] of rows) {
      const lines = healthMarkdown(textual(raw)).split('\n');
      expect(lines, raw).toContain(`- Detail: ${escaped}`);
      expect(lines, raw).toContain(`- Fix: ${escaped}`);
      if (everyText) {
        expect(lines, raw).toContain(`**${escaped}**`);
        expect(lines, raw).toContain(`- Cause: ${escaped}`);
      }
    }

    const raw = String.raw`  \*raw\* &lt;b&gt; &#35; done `;
    const escaped = String.raw`\\\*raw\\\* \&lt;b\&gt; \&#35; done`;
    const data = applyEvents(
      applyEvents(running(), [
        {
          type: 'finding',
          finding: sampleFinding('storage.file-missing', 'error', lake, {
            title: raw,
            detail: raw,
            cause: raw,
            fix: raw,
          }),
        },
      ]),
      [{ type: 'group', status: { group: 'storage', state: 'skipped', reason: raw.trim() } }],
    );
    const lines = healthMarkdown(data).split('\n');
    for (const line of [
      `**${escaped}**`,
      `- Detail: ${escaped}`,
      `- Cause: ${escaped}`,
      `- Fix: ${escaped}`,
    ]) {
      expect(lines).toContain(line);
    }
    expect(lines).toContain(`- Not checked: Storage: ${escaped}`);
  });

  it('lists at most 200 findings and counts the ones left out', () => {
    for (const total of [MARKDOWN_FINDINGS + 1, MARKDOWN_FINDINGS + 5]) {
      const many = Array.from({ length: total }, (_, index) =>
        sampleFinding('storage.file-orphaned', 'info', lake, {
          object: `k${String(index).padStart(3, '0')}`,
        }),
      );
      const data = applyEvents(
        running(),
        many.map((finding) => ({ type: 'finding' as const, finding })),
      );
      const document = healthMarkdown(data);

      expect(document.match(/^\*\*Title of storage\.file-orphaned\*\*$/gm), String(total)).toHaveLength(
        MARKDOWN_FINDINGS,
      );
      expect(document).toContain(`### Infos (${total})`);
      expect(document).toContain(
        `… ${total - MARKDOWN_FINDINGS} more omitted (limit: ${MARKDOWN_FINDINGS}).`,
      );
    }
  });
});

describe('the document of a finding that the panel can fix', () => {
  const suggestion = {
    endpoint: 'http://rustfs:9000',
    urlStyle: 'path',
    source: 'AWS_ENDPOINT_URL_S3',
  } as const;
  const document = (changes: Partial<Parameters<typeof sampleFinding>[3]> = {}) =>
    healthMarkdown(
      applyEvents(freshData('Lake', lake, choice, 'running'), [
        {
          type: 'finding',
          finding: sampleFinding('connection.endpoint-not-set', 'error', lake, {
            settingKey: 's3.endpoint',
            suggestion,
            ...changes,
          }),
        },
      ]),
    ).split('\n');

  it('names the setting, the suggestion and its source, none without one, and keeps its text inside a code span', () => {
    const lines = document();
    expect(lines.some((line) => line.includes('`aantje.s3.endpoint`'))).toBe(true);
    const suggested = lines.find((line) => line.startsWith('- Suggested endpoint:'));
    expect(suggested).toContain('`http://rustfs:9000`');
    expect(suggested).toContain('`AWS_ENDPOINT_URL_S3`');
    expect(suggested).toContain('`path`');

    const bare = document({ suggestion: undefined });
    expect(bare.filter((line) => line.startsWith('- Suggested endpoint:'))).toEqual([]);
    expect(bare.length).toBeLessThan(lines.length);

    const aws = document({
      suggestion: { endpoint: 'https://s3.eu-west-1.amazonaws.com', source: 'AWS_ENDPOINT_URL' },
    });
    const awsLine = aws.find((line) => line.startsWith('- Suggested endpoint:'));
    expect(awsLine).toContain('`https://s3.eu-west-1.amazonaws.com`');
    expect(awsLine).not.toContain('URL style');

    const hostile = document({ suggestion: { endpoint: 'x`\n# evil', source: 'A`B' } });
    expect(hostile.filter((line) => line.startsWith('#'))).not.toContain('# evil');
    expect(hostile.some((line) => line.startsWith('- Suggested endpoint: ``x`'))).toBe(true);
  });
});

// The values of the two documents of the history fixture: headings, table rows, findings, SQL; no prose.
const HEALTHY_SHAPE = {
  headings: [
    '# Health check of History lake',
    '## Groups',
    '## Findings',
    '### Infos (2)',
    '#### Lakehouse',
    '#### `shop.events`',
    '## What was checked',
  ],
  rows: [
    '| Property | Value |',
    '| --- | --- |',
    '| Scope | Lakehouse |',
    '| Depth | Quick + existence |',
    '| Checked snapshot | @56 |',
    '| Errors | 0 |',
    '| Warnings | 0 |',
    '| Infos | 2 |',
    '| Duration | 1.5 s |',
    '| Group | State |',
    '| --- | --- |',
    '| Catalog | ✔ Done |',
    '| Connection | ✔ Done |',
    '| Storage | ✔ Done |',
    '| Deep | – Skipped: Not part of the quick check. |',
  ],
  findings: ['catalog.cleanup-pending', 'catalog.small-files'],
  explained: 6,
  sql: [
    'SELECT * FROM __ducklake_metadata_lake.ducklake_files_scheduled_for_deletion ORDER BY schedule_start;',
    "CALL ducklake_cleanup_old_files('lake', dry_run => true);",
    'SELECT count(*) AS files, count(*) FILTER (WHERE file_size_bytes < 16777216) AS small FROM __ducklake_metadata_lake.ducklake_data_file WHERE table_id = 3 AND end_snapshot IS NULL;',
    "CALL ducklake_merge_adjacent_files('lake', 'events', schema => 'shop');",
  ],
};

const BROKEN_SHAPE = {
  headings: [
    '# Health check of History lake',
    '## Groups',
    '## Findings',
    '### Errors (2)',
    '#### `shop.events`',
    '### Infos (2)',
    '#### Lakehouse',
    '#### `shop.events`',
    '## What was checked',
  ],
  rows: [
    '| Property | Value |',
    '| --- | --- |',
    '| Scope | Lakehouse |',
    '| Depth | Deep check, up to 200 files |',
    '| Checked snapshot | @56 |',
    '| Errors | 2 |',
    '| Warnings | 0 |',
    '| Infos | 2 |',
    '| Duration | 1.5 s |',
    '| Group | State |',
    '| --- | --- |',
    '| Catalog | ✔ Done |',
    '| Connection | ✔ Done |',
    '| Storage | ✔ Done |',
    '| Deep | ✔ Done |',
  ],
  findings: [
    'catalog.negative-counts',
    'storage.file-missing',
    'catalog.cleanup-pending',
    'catalog.small-files',
  ],
  explained: 12,
  sql: [
    "SELECT 'data' AS kind, data_file_id AS file_id, record_count, file_size_bytes FROM __ducklake_metadata_lake.ducklake_data_file WHERE record_count < 0 OR file_size_bytes < 0 UNION ALL SELECT 'delete', delete_file_id, delete_count, file_size_bytes FROM __ducklake_metadata_lake.ducklake_delete_file WHERE delete_count < 0 OR file_size_bytes < 0;",
    'SELECT * FROM __ducklake_metadata_lake.ducklake_data_file WHERE data_file_id = 0;',
    'SELECT * FROM __ducklake_metadata_lake.ducklake_files_scheduled_for_deletion ORDER BY schedule_start;',
    "CALL ducklake_cleanup_old_files('lake', dry_run => true);",
    'SELECT count(*) AS files, count(*) FILTER (WHERE file_size_bytes < 16777216) AS small FROM __ducklake_metadata_lake.ducklake_data_file WHERE table_id = 3 AND end_snapshot IS NULL;',
    "CALL ducklake_merge_adjacent_files('lake', 'events', schema => 'shop');",
  ],
};
