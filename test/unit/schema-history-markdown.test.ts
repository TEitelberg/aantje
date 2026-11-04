import { beforeAll, describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../../src/catalog/model';
import { schemaHistoryMarkdown } from '../../src/schema-history/markdown';
import { CELL_KINDS, LEGEND, MAX_ROWS, OLDER_NOTE, buildHistory } from '../../src/schema-history/model';
import type { SchemaHistoryData } from '../../src/schema-history/model';
import { schemaHistoryKind } from '../../src/schema-history/kind';
import { HISTORY_ID } from '../support/expected-history';
import { TIME, historySchema } from './schema-history-support';

let evolved: SchemaHistoryData;
let dropped: SchemaHistoryData;

beforeAll(async () => {
  evolved = await historySchema(HISTORY_ID.evolving);
  dropped = await historySchema(HISTORY_ID.oldStuff);
});

const column = (id: number, name: string, type = 'int32'): ColumnInfo => ({
  id,
  name,
  type,
  nullable: true,
  defaultValue: null,
  comment: null,
  children: [],
});

describe('the Schema History as a Markdown document', () => {
  it('lists the matrix of main.evolved with the table events in a row, the legend and the snapshots, newest first', () => {
    expect(schemaHistoryMarkdown(evolved)).toBe(
      [
        '# Schema history of main\\.evolved',
        '',
        'Read from History; the newest snapshot of the catalog is @56.',
        '',
        '| Property | Value |',
        '| --- | --- |',
        '| Table | `main.evolved` |',
        '| Snapshots in the matrix | 9 of 9 |',
        '| Kinds of change | all |',
        '| Column filter | none |',
        '| Range | all |',
        '',
        '## Matrix',
        '',
        '| Column | Now | @26 | @28 | @29 | @30 | @31 | @32 | @33 | @34 | @35 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        '| Table |  | `created as main.evolving` |  |  |  |  |  |  |  | `renamed main.evolving → main.evolved` |',
        '| `id` | `int32` | `+ added: int32` |  |  |  |  |  |  |  |  |',
        '| `title (formerly name)` | `varchar` | `+ added: varchar` |  | `↔ renamed: name → title` |  |  |  |  |  |  |',
        '| `info` | `struct` | `+ added: struct` |  |  |  |  |  |  |  |  |',
        '| `info.a` | `int32` | `+ added: int32` |  |  |  |  |  |  |  |  |',
        '| `info.b` | `varchar` | `+ added: varchar` |  |  |  |  |  |  |  |  |',
        '| `info.c` | `float64` |  |  |  |  |  | `+ added: float64` |  |  |  |',
        '| `n` | `int64` | `+ added: int32` |  |  | `Δ type: int32 → int64` |  |  |  |  |  |',
        '| `flag` | `boolean` |  |  |  |  |  |  | `+ added: boolean` | `= default: false → true` |  |',
        '| `extra` | dropped |  | `+ added: float64` |  |  | `− dropped` |  |  |  |  |',
        '',
        LEGEND,
        '',
        '## Snapshots',
        '',
        '| Snapshot | Time (UTC) | Author | Message | Table |',
        '| --- | --- | --- | --- | --- |',
        '| @35 | 2026-11-01 10:00:00 |  |  | `renamed main.evolving → main.evolved` |',
        ...[34, 33, 32, 31, 30, 29, 28].map((id) => `| @${id} | 2026-11-01 10:00:00 |  |  |  |`),
        '| @26 | 2026-11-01 10:00:00 |  |  | `created as main.evolving` |',
        '',
      ].join('\n'),
    );
    expect(LEGEND).toBe(
      'Signs: + added, − dropped, ↔ renamed, Δ type changed, ! nullability changed, = default changed, # comment changed, ↕ moved.',
    );
  });

  it('shows what the filters leave and names them', () => {
    const text = schemaHistoryMarkdown(evolved, {
      kinds: ['typeChanged', 'renamed'],
      text: 'N',
      range: { from: 29, to: 30 },
    });
    expect(text).toContain('| Snapshots in the matrix | 2 of 9 |');
    expect(text).toContain('| Kinds of change | Renamed, Type changed |');
    expect(text).toContain('| Column filter | `N` |');
    expect(text).toContain('| Range | @29 to @30 |');
    expect(text).toContain(
      [
        '| Column | Now | @29 | @30 |',
        '| --- | --- | --- | --- |',
        '| Table |  |  |  |',
        '| `title (formerly name)` | `varchar` | `↔ renamed: name → title` |  |',
        '| `n` | `int64` |  | `Δ type: int32 → int64` |',
      ].join('\n'),
    );
    expect(text).not.toContain('`flag`');
  });

  it('fits a view to the data: a range outside the snapshots is held inside, kinds that nobody knows are dropped', () => {
    const text = schemaHistoryMarkdown(evolved, {
      kinds: ['added', 'exploded' as never],
      text: 'flag',
      range: { from: 0, to: 1000 },
    });
    expect(text).toContain('| Kinds of change | Added |');
    expect(text).toContain('| Range | @26 to @35 |');
    expect(text).toContain('| Column | Now | @26 | @33 | @35 |');
    expect(text).toContain('| `flag` | `boolean` |  | `+ added: boolean` |  |');
  });

  it('says so when the filters leave nothing', () => {
    const text = schemaHistoryMarkdown({ ...evolved, snapshots: [], columns: [] });
    expect(text).toContain('No column or snapshot is left by the filters.');
    expect(text).toContain('No snapshot is left by the filters.');
    expect(schemaHistoryMarkdown(evolved, { kinds: [], text: '' })).toContain('| Kinds of change | none |');
  });

  it('names a view with every kind of change as all, trims the words of the filter, and keeps the connection on one line', () => {
    const text = schemaHistoryMarkdown(
      { ...evolved, connection: 'My' + String.fromCharCode(10) + '   lake  ' },
      { kinds: CELL_KINDS, text: '  flag ' },
    );
    expect(text).toContain('| Kinds of change | all |');
    expect(text).toContain('| Column filter | `flag` |');
    expect(text).toContain('Read from My lake;');
  });

  it('writes the time of an expired snapshot as expired, and the events of a snapshot side by side', () => {
    const data = buildHistory('Lake', 1, 9, {
      versions: [
        {
          snapshot: 1,
          time: null,
          author: null,
          commitMessage: null,
          table: { schemaName: 's', name: 'a' },
          columns: [column(1, 'x')],
        },
        {
          snapshot: 2,
          time: TIME,
          author: null,
          commitMessage: null,
          table: { schemaName: 's', name: 'b' },
          columns: [column(1, 'x')],
        },
      ],
      more: false,
    });
    const text = schemaHistoryMarkdown(data);
    expect(text).toContain('| @1 | expired |');
    expect(text).toContain('| @2 | 2026-11-01 10:00:00 |');
    expect(text).toContain('| Table |  | `created as s.a` | `renamed s.a → s.b` |');
  });

  it('marks the columns of a dropped table, and says that older versions were not read', async () => {
    const text = schemaHistoryMarkdown(dropped);
    expect(text).toContain('| `x` | table dropped | `+ added: int32` |  |');
    expect(text).toContain('| Table |  | `created as shop.old_stuff` | `dropped (shop.old_stuff)` |');
    expect(schemaHistoryMarkdown(await historySchema(HISTORY_ID.evolving, 3))).toContain(OLDER_NOTE);
    expect(schemaHistoryMarkdown(evolved)).not.toContain(OLDER_NOTE);
  });

  it('cuts a long matrix at 100 rows and counts the others', () => {
    const many = buildHistory('Lake', 1, 9, {
      versions: [
        {
          snapshot: 1,
          time: TIME,
          author: null,
          commitMessage: null,
          table: { schemaName: 's', name: 't' },
          columns: Array.from({ length: 130 }, (_, index) => column(index + 1, `c${index + 1}`)),
        },
      ],
      more: false,
    });
    const text = schemaHistoryMarkdown(many);
    expect(text.split('\n').filter((line) => line.startsWith('| `c'))).toHaveLength(MAX_ROWS);
    expect(text).toContain('… 30 more omitted (limit: 100).');
    expect(schemaHistoryMarkdown(many, { kinds: CELL_KINDS, text: 'c130' })).toContain('| `c130` |');
  });

  it('writes names, types, defaults, authors and messages from the catalog as code, and the connection as text', () => {
    const hostile = '<img src=x onerror=alert(1)> | `pipe`\n# heading';
    const data: SchemaHistoryData = {
      ...evolved,
      connection: hostile,
      schema: hostile,
      name: hostile,
      snapshots: [
        {
          id: 1,
          time: TIME,
          author: hostile,
          message: hostile,
          events: [{ kind: 'created', name: hostile, from: null }],
          previous: null,
          exists: true,
        },
      ],
      columns: [
        {
          id: 1,
          parent: null,
          path: [hostile],
          formerNames: [hostile],
          now: hostile,
          cells: [{ snapshot: 1, kind: 'added', text: `+ added: ${hostile}` }],
        },
      ],
    };
    const text = schemaHistoryMarkdown(data);
    // Markup characters and the line break of a name are escaped or flattened in the title.
    const [title, afterTitle] = text.split('\n');
    expect(title).not.toMatch(/(^|[^\\])[<>`|]/);
    expect(afterTitle).toBe('');
    expect(text).not.toMatch(/^# heading/m);
    // A pipe of the catalog is escaped, so every row of a table has as many cells as its heading.
    const cells = (line: string): number => line.split(/(?<!\\)\|/).length;
    const tables = text.split('\n\n').filter((block) => block.startsWith('| '));
    expect(tables).toHaveLength(3);
    for (const table of tables) {
      const widths = new Set(table.trimEnd().split('\n').map(cells));
      expect(widths.size, table).toBe(1);
    }
    expect(text).toContain('<img src=x onerror=alert(1)> \\| `pipe` # heading');
  });
});

describe('the Schema History as a report of the shell', () => {
  it('names its view type, builds the message of the page, and writes the document through the function above', () => {
    expect(schemaHistoryKind.viewType).toBe('aantje.schemaHistory');
    expect(schemaHistoryKind.message(evolved)).toEqual({ type: 'schemaHistory', data: evolved });
    expect(schemaHistoryKind.toMarkdown(evolved, undefined)).toBe(schemaHistoryMarkdown(evolved));
    expect(schemaHistoryKind.css).toContain('.matrix');
  });

  it('takes the actions and the view of its protocol and nothing else', () => {
    expect(schemaHistoryKind.isAction?.({ type: 'action', action: 'scriptAlter' })).toBe(true);
    expect(schemaHistoryKind.isAction?.({ type: 'action', action: 'showLatest' })).toBe(false);
    expect(schemaHistoryKind.isView?.({ kinds: CELL_KINDS, text: '' })).toBe(true);
    expect(schemaHistoryKind.isView?.({ filter: '' })).toBe(false);
  });
});
