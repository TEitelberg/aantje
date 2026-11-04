import { describe, expect, it } from 'vitest';
import { planAdvisorAction } from '../../src/advisor/actions';
import { advisorKind } from '../../src/advisor/kind';
import { advisorMarkdown } from '../../src/advisor/markdown';
import type { AdvisorData } from '../../src/advisor/model';
import { isAdvisorAction, isAdvisorMessage } from '../../src/advisor/protocol';
import type { AdvisorAction } from '../../src/advisor/protocol';
import { scriptTarget } from '../../src/script-target';
import { maintenanceOf } from '../../src/maintenance';
import { ReportPanels } from '../../src/shell/panels';
import type { CatalogTree } from '../../src/tree/model';
import { sampleAdvisor, table } from './advisor-support';
import { FakePanel } from './fake-panel';

/** What the page and the extension accept from each other, after the trip through JSON that a webview message makes. */
const message = (data: unknown): unknown => JSON.parse(JSON.stringify({ type: 'advisor', data }));

describe('the data that the Advisor page accepts', () => {
  it('accepts the data of the sample, with skipped measurements and a cut list', () => {
    expect(isAdvisorMessage(message(sampleAdvisor()))).toBe(true);
    expect(isAdvisorMessage(message(sampleAdvisor({ scope: { kind: 'schema', id: 2, name: 'shop' } })))).toBe(
      true,
    );
    expect(
      isAdvisorMessage(
        message(
          sampleAdvisor({
            expiry: { state: 'skipped', reason: 'HTTP 403' },
            cleanup: { state: 'skipped', reason: 'x' },
            orphans: { state: 'skipped', reason: 'x' },
            merge: [],
            rewrite: [],
            flush: [],
            more: true,
          }),
        ),
      ),
    ).toBe(true);
  });

  it('refuses malformed data, a message of another report, and data that is no object', () => {
    const rows: [string, (data: AdvisorData) => unknown][] = [
      ['a missing connection', ({ connection: _c, ...rest }) => rest],
      ['a missing scope', ({ scope: _s, ...rest }) => rest],
      ['a schema scope without a name', (data) => ({ ...data, scope: { kind: 'schema', id: 2 } })],
      ['a snapshot as text', (data) => ({ ...data, snapshot: '12' })],
      ['no time of the read', ({ readAt: _r, ...rest }) => rest],
      ['more as false', (data) => ({ ...data, more: false })],
      ['a measurement of an unknown state', (data) => ({ ...data, expiry: { state: 'running' } })],
      ['a skipped measurement without its reason', (data) => ({ ...data, cleanup: { state: 'skipped' } })],
      [
        'a measurement with a negative size',
        (data) => ({ ...data, orphans: { state: 'measured', value: { files: 1, bytes: -1, sized: 1 } } }),
      ],
      [
        'an expiry without the number of snapshots',
        (data) => ({
          ...data,
          expiry: { state: 'measured', value: { expiring: 1, oldest: null, newest: null } },
        }),
      ],
      [
        'a candidate without its table',
        (data) => ({ ...data, merge: [{ files: 1, smallFiles: 1, estimatedAfter: 1 }] }),
      ],
      [
        'a table with an id as text',
        (data) => ({ ...data, flush: [{ table: { ...table(1, 'a'), id: '1' }, rows: 1 }] }),
      ],
      [
        'a policy source nobody knows',
        (data) => ({ ...data, policy: { ...data.policy, expire: { text: 'x', source: 'env' } } }),
      ],
      [
        'a threshold as text',
        (data) => ({ ...data, policy: { ...data.policy, rewrite: { share: '0.5', source: 'option' } } }),
      ],
      ['unreadable options as text', (data) => ({ ...data, policy: { ...data.policy, unreadable: 'x' } })],
      [
        'scheduled files as text',
        (data) => ({ ...data, scheduled: { count: '1', oldestScheduledAt: null } }),
      ],
    ];
    for (const [name, change] of rows) {
      expect(isAdvisorMessage(message(change(sampleAdvisor()))), name).toBe(false);
    }
    expect(isAdvisorMessage({ type: 'storage', data: sampleAdvisor() })).toBe(false);
    expect(isAdvisorMessage({ type: 'advisor', data: 'x' })).toBe(false);
    expect(isAdvisorMessage(null)).toBe(false);
  });
});

describe('the requests that the extension accepts from the page', () => {
  const action = (fields: Record<string, unknown>): unknown => ({ type: 'action', ...fields });

  it('accepts the declared actions with exactly their fields, and refuses the rest', () => {
    for (const fields of [
      { action: 'scriptExpire' },
      { action: 'scriptCleanup' },
      { action: 'scriptOrphans' },
      { action: 'scriptMerge', table: 1 },
      { action: 'scriptRewrite', table: 3 },
      { action: 'scriptFlush', table: 5 },
      { action: 'showStatistics', table: 1 },
      { action: 'revealTable', table: 1 },
      { action: 'showStorage' },
      { action: 'checkHealth' },
      { action: 'maintenanceScript' },
    ]) {
      expect(isAdvisorAction(action(fields)), JSON.stringify(fields)).toBe(true);
    }
    const rows: [string, Record<string, unknown>][] = [
      ['an action nobody declared', { action: 'dropEverything' }],
      ['a command id for an action', { action: 'aantje.checkHealth' }],
      ['no action', {}],
      ['a table for a script of the lake', { action: 'scriptExpire', table: 1 }],
      ['a table for the storage report', { action: 'showStorage', table: 1 }],
      ['a script of a table without a table', { action: 'scriptMerge' }],
      ['a table as text', { action: 'scriptRewrite', table: '3' }],
      ['a negative table', { action: 'revealTable', table: -1 }],
      ['a fraction as table', { action: 'showStatistics', table: 1.5 }],
      ['text that would end up in a script', { action: 'scriptFlush', table: 5, sql: 'DROP TABLE x' }],
      ['an older-than that the page chose', { action: 'scriptExpire', olderThan: '1 second' }],
      ['a table that the prototype provides', { action: 'toString' }],
    ];
    for (const [name, fields] of rows) {
      expect(isAdvisorAction(action(fields)), name).toBe(false);
    }
    expect(isAdvisorAction({ action: 'showStorage' })).toBe(false);
    expect(isAdvisorAction(null)).toBe(false);
    // The kind of the report accepts the same, and sends the data as an advisor message.
    expect(advisorKind.isAction?.(action({ action: 'checkHealth' }))).toBe(true);
    expect(advisorKind.message(sampleAdvisor())).toEqual({ type: 'advisor', data: sampleAdvisor() });
  });

  it('takes no view for Open as Markdown: the page names none, and the extension builds the document from its data', () => {
    const panel = new FakePanel('Advisor');
    const documents: string[] = [];
    const shown = new ReportPanels(() => panel, advisorKind, {
      openMarkdown: (markdown) => documents.push(markdown),
    });
    shown.show('a', 'Advisor', sampleAdvisor());
    panel.send({ type: 'markdown', view: { filter: 'x' } });
    expect(documents).toEqual([]);
    panel.send({ type: 'markdown' });
    expect(documents).toEqual([advisorMarkdown(sampleAdvisor())]);
  });
});

describe('the plan of an action', () => {
  const data = sampleAdvisor();
  const ask = (request: Record<string, unknown>) =>
    planAdvisorAction(data, { type: 'action', ...request } as AdvisorAction);

  it('names the script of the lake for the three that act on the lake', () => {
    expect(ask({ action: 'scriptExpire' })).toEqual({ action: 'script', kind: 'expire' });
    expect(ask({ action: 'scriptCleanup' })).toEqual({ action: 'script', kind: 'cleanup' });
    expect(ask({ action: 'scriptOrphans' })).toEqual({ action: 'script', kind: 'orphans' });
    expect(ask({ action: 'showStorage' })).toEqual({ action: 'showStorage' });
    expect(ask({ action: 'checkHealth' })).toEqual({ action: 'checkHealth' });
  });

  it('names the table of the data for a script, and only for the kind that the advisor named it for', () => {
    expect(ask({ action: 'scriptMerge', table: 1 })).toEqual({
      action: 'script',
      kind: 'merge',
      table: table(1, 'events'),
    });
    expect(ask({ action: 'scriptRewrite', table: 3 })).toMatchObject({
      kind: 'rewrite',
      table: { name: 'orders' },
    });
    expect(ask({ action: 'scriptFlush', table: 5 })).toMatchObject({
      kind: 'flush',
      table: { name: 'clicks' },
    });
    // events is a candidate for a merge only.
    expect(ask({ action: 'scriptRewrite', table: 1 })).toBeUndefined();
    expect(ask({ action: 'scriptFlush', table: 3 })).toBeUndefined();
    expect(ask({ action: 'scriptMerge', table: 5 })).toBeUndefined();
  });

  it('shows the statistics and the tree for any table of the data, and refuses a table it was not sent', () => {
    expect(ask({ action: 'showStatistics', table: 4 })).toEqual({
      action: 'showStatistics',
      table: table(4, 'carts'),
    });
    expect(ask({ action: 'revealTable', table: 5 })).toMatchObject({ action: 'revealTable' });
    expect(ask({ action: 'showStatistics', table: 99 })).toBeUndefined();
    expect(ask({ action: 'revealTable', table: 99 })).toBeUndefined();
    expect(ask({ action: 'scriptMerge', table: 99 })).toBeUndefined();
  });
});

describe('the scripts that the actions open', () => {
  const tree = { state: () => ({ status: 'connected', snapshot: 'latest' }) } as Pick<CatalogTree, 'state'>;
  const script = (request: Record<string, unknown>): string | undefined => {
    const plan = planAdvisorAction(
      sampleAdvisor({
        merge: [
          {
            table: table(1, "it's", "o'brien"),
            files: 9,
            smallFiles: 9,
            smallBytes: 5400,
            estimatedAfter: 1,
          },
        ],
      }),
      { type: 'action', ...request } as AdvisorAction,
    );
    if (plan?.action !== 'script') return undefined;
    const { kind, ref } = scriptTarget('c', plan);
    return maintenanceOf(tree, kind, ref);
  };

  it('starts with the dry run for the three that destroy, and has the real call commented out', () => {
    for (const [action, fn] of [
      ['scriptExpire', 'ducklake_expire_snapshots'],
      ['scriptCleanup', 'ducklake_cleanup_old_files'],
      ['scriptOrphans', 'ducklake_delete_orphaned_files'],
    ] as const) {
      const lines = (script({ action }) ?? '').split('\n');
      const age = action === 'scriptExpire' ? ' older_than => now() - INTERVAL 30 DAY,' : '';
      expect(lines.filter((line) => line.startsWith('CALL '))).toEqual([
        `CALL ${fn}('lake',${age} dry_run => true);`,
      ]);
      expect(lines.filter((line) => line.startsWith('-- CALL '))[0]).toBe(
        action === 'scriptExpire'
          ? `-- CALL ${fn}('lake', older_than => now() - INTERVAL 30 DAY);`
          : `-- CALL ${fn}('lake');`,
      );
    }
  });

  it('names the table of the recommendation with its schema, in string literals with the quotes doubled', () => {
    expect(script({ action: 'scriptMerge', table: 1 })).toContain(
      "CALL ducklake_merge_adjacent_files('lake', 'it''s', schema => 'o''brien');",
    );
  });
});
