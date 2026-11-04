import { beforeAll, describe, expect, it } from 'vitest';
import type { AdvisorData } from '../../src/advisor/model';
import type { FakeNode } from '../support/fake-dom';
import { buildClientBundle, startPage } from '../support/page-harness';
import { sampleAdvisor, table } from './advisor-support';

/**
 * Runs the real browser bundle against a stand-in for the DOM: the Advisor page shows what the extension sends, ranked,
 * with the words and symbols for impact, effort and risk, and posts only the requests that the extension accepts.
 */

let bundle: string;

beforeAll(async () => {
  bundle = await buildClientBundle();
});

const message = (data: AdvisorData = sampleAdvisor()) => ({ type: 'advisor', data });

function start() {
  const page = startPage(bundle);
  const find = (predicate: (node: FakeNode) => boolean) => page.app().find(predicate);
  const view = {
    h1: () => find((node) => node.tag === 'h1')[0]?.textContent,
    subtitle: () => find((node) => node.hasClass('subtitle'))[0]?.textContent,
    h2: () => find((node) => node.tag === 'h2').map((node) => node.textContent),
    cards: () => find((node) => node.hasClass('card')).map((card) => card.children.map((c) => c.textContent)),
    cardClasses: () => find((node) => node.hasClass('card')).map((card) => card.className),
    buttons: () => find((node) => node.tag === 'button').map((button) => button.textContent),
    cardsOfFindings: () => find((node) => node.tag === 'details'),
    titles: () => find((node) => node.tag === 'summary').map((node) => node.textContent),
    text: () => page.app().textContent,
    notes: () => find((node) => node.hasClass('note')).map((node) => node.textContent),
    items: () => find((node) => node.tag === 'li').map((node) => node.textContent),
  };
  return { ...page, view, find };
}

/** The buttons of one recommendation (the card whose title starts with the text). */
function buttonsOf(find: ReturnType<typeof start>['find'], title: string): FakeNode[] {
  const card = find((node) => node.tag === 'details').find((candidate) =>
    candidate.find((node) => node.tag === 'summary')[0]?.textContent.includes(title),
  );
  return card?.find((node) => node.tag === 'button') ?? [];
}

describe('the Advisor page', () => {
  it('tells the extension that it is ready, and says that it is reading until the data arrives', () => {
    const { posted, app } = start();
    expect(posted).toEqual([{ type: 'ready' }]);
    expect(app().textContent).toBe('Reading...');
  });

  it('shows the key figures, the recommendations in rank, the sections and the policy', () => {
    const { send, view } = start();
    send(message());

    expect(view.h1()).toBe('Maintenance Advisor');
    expect(view.subtitle()).toBe(
      'Snapshot @130 · Lake · read 2026-10-31 12:00:00 UTC · dry runs only, nothing is changed',
    );
    expect(view.cards()).toEqual([
      ['Snapshots to expire', '100', 'of 120, older than 30 days'],
      ['Files to clean up', '40', '3 GB'],
      ['Orphaned files', '2', '5.4 KB'],
      ['Reclaimable space', '3 GB', '42 files'],
      ['Scheduled for deletion', '45', '40 ready now, 5 waiting'],
      ['Merge candidates', '2', '2 tables, about 1,842 files fewer'],
      ['Rewrite candidates', '2', '2 tables'],
      ['Flush candidates', '1', '2,000,000 inlined rows'],
      ['Expire older than', '30 days', 'default of the advisor'],
    ]);
    expect(view.h2()).toEqual(['Recommendations', 'Policy']);
    expect(view.titles()).toEqual([
      '1. Rewrite 3 data files of shop.orders in which 95 % of the rows are deleted',
      '2. Merge 1,900 small files of shop.events',
      '3. Flush 2,000,000 inlined rows of shop.clicks to Parquet',
      '4. Clean up 40 files that no snapshot needs (3 GB)',
      '5. Expire 100 snapshots older than 30 days',
      '6. Merge 6 small files of shop.notes',
      '7. Data files of shop.carts have lost at least half of their rows',
      '8. Delete 2 files that the catalog does not know (5.4 KB)',
    ]);
    expect(view.items()).toHaveLength(4);
  });

  it('writes impact, effort and risk as words and symbols, and marks a risky recommendation with a warning', () => {
    const { send, view } = start();
    send(message());

    expect(view.text()).toContain('Impact: high ▲▲▲ · Effort: low ▲△△ · Risk: ⚠ medium ▲▲△');
    expect(view.text()).toContain('Impact: medium ▲▲△ · Effort: low ▲△△ · Risk: ⚠ high ▲▲▲');
    const classes = view.cardsOfFindings().map((card) => card.className);
    // Expire and the orphaned files are risk high; the others are plain.
    expect(classes.filter((name) => name.includes('warning'))).toHaveLength(2);
  });

  it('opens the first recommendation and shows the exact numbers behind each', () => {
    const { send, view } = start();
    send(message());

    const open = view.cardsOfFindings().map((card) => card.open);
    expect(open).toEqual([true, false, false, false, false, false, false, false]);
    expect(view.text()).toContain('Files: 40 · Size: 3 GB · Scheduled but too young: 5');
    expect(view.text()).toContain(
      'Data files: 2,000 · Small files: 1,900 · Estimated after the merge: about 163 · Estimated fewer files: about 1,837',
    );
  });

  it('offers the script, the table and the other reports behind a recommendation, and asks for them by id', () => {
    const { send, find, posted } = start();
    send(message());
    posted.length = 0;

    const merge = buttonsOf(find, '2. Merge');
    expect(merge.map((button) => button.textContent)).toEqual([
      'Open script',
      'Show table in tree',
      'Show Statistics',
      'Show Storage Report',
      'Check Health',
    ]);
    for (const button of merge) button.fire('click');
    const cleanup = buttonsOf(find, '4. Clean up');
    expect(cleanup.map((button) => button.textContent)).toEqual([
      'Open script',
      'Show Storage Report',
      'Check Health',
    ]);
    cleanup[0]?.fire('click');
    buttonsOf(find, '5. Expire')[0]?.fire('click');
    buttonsOf(find, '8. Delete')[0]?.fire('click');
    buttonsOf(find, '1. Rewrite')[0]?.fire('click');
    buttonsOf(find, '3. Flush')[0]?.fire('click');

    expect(posted).toEqual([
      { type: 'action', action: 'scriptMerge', table: 1 },
      { type: 'action', action: 'revealTable', table: 1 },
      { type: 'action', action: 'showStatistics', table: 1 },
      { type: 'action', action: 'showStorage' },
      { type: 'action', action: 'checkHealth' },
      { type: 'action', action: 'scriptCleanup' },
      { type: 'action', action: 'scriptExpire' },
      { type: 'action', action: 'scriptOrphans' },
      { type: 'action', action: 'scriptRewrite', table: 3 },
      { type: 'action', action: 'scriptFlush', table: 5 },
    ]);
  });

  it('asks for new measurements with Refresh and for the document with Open as Markdown, without a view', () => {
    const { send, find, posted } = start();
    send(message());
    posted.length = 0;

    find((node) => node.tag === 'button' && node.textContent === 'Refresh')[0]?.fire('click');
    find((node) => node.tag === 'button' && node.textContent === 'Open as Markdown')[0]?.fire('click');

    expect(posted).toEqual([{ type: 'refresh' }, { type: 'markdown' }]);
  });

  it('asks for the script of all recommendations from the header, and has no button when nothing is recommended', () => {
    const { send, find, posted } = start();
    const button = (): ReturnType<typeof find> =>
      find(
        (node) => node.tag === 'button' && (node.textContent ?? '').startsWith('Create maintenance script'),
      );
    send(message());
    posted.length = 0;

    button()[0]?.fire('click');

    expect(posted).toEqual([{ type: 'action', action: 'maintenanceScript' }]);

    send(
      message(
        sampleAdvisor({
          merge: [],
          rewrite: [],
          flush: [],
          expiry: { state: 'skipped', reason: 'x' },
          cleanup: { state: 'skipped', reason: 'x' },
          orphans: { state: 'skipped', reason: 'x' },
        }),
      ),
    );

    expect(button()).toEqual([]);
  });

  it('says in words and with a warning which measurement was skipped and why, and offers the script', () => {
    const { send, view, find, posted } = start();
    send(
      message(
        sampleAdvisor({
          orphans: { state: 'skipped', reason: 'HTTP 403' },
          expiry: { state: 'skipped', reason: 'The statement exceeded its time limit of 30 s.' },
        }),
      ),
    );

    expect(view.h2()).toEqual(['Recommendations', 'Not measured', 'Policy']);
    expect(view.notes()).toContain(
      'Expire Snapshots was not measured: The statement exceeded its time limit of 30 s.',
    );
    expect(view.notes()).toContain('Delete Orphaned Files was not measured: HTTP 403');
    expect(view.cards()[0]).toEqual([
      'Snapshots to expire',
      'not measured',
      'The statement exceeded its time limit of 30 s.',
    ]);
    expect(view.cardClasses().filter((name) => name.includes('warning'))).toHaveLength(2);
    expect(view.titles().join('\n')).not.toContain('Expire 100');
    posted.length = 0;
    const skipped = find((node) => node.hasClass('skipped'))[0];
    skipped?.find((node) => node.tag === 'button').forEach((button) => button.fire('click'));
    expect(posted).toEqual([
      { type: 'action', action: 'scriptExpire' },
      { type: 'action', action: 'scriptOrphans' },
    ]);
  });

  it('says that nothing is worth doing when nothing is, and that a list of tables was cut when it was', () => {
    const { send, view } = start();
    send(
      message(
        sampleAdvisor({
          expiry: { state: 'measured', value: { snapshots: 3, expiring: 0, oldest: null, newest: null } },
          cleanup: { state: 'measured', value: { files: 0, bytes: 0, sized: 0 } },
          orphans: { state: 'measured', value: { files: 0, bytes: 0, sized: 0 } },
          merge: [],
          rewrite: [],
          flush: [],
          more: true,
        }),
      ),
    );

    expect(view.text()).toContain('Nothing measured is worth doing now.');
    expect(view.cardsOfFindings()).toHaveLength(0);
    expect(view.notes()).toContain('The lists of tables were cut at 100 per kind; more tables may qualify.');
  });

  it('shows names from the catalog as text, never as markup', () => {
    const { send, view } = start();
    send(
      message(
        sampleAdvisor({
          merge: [
            {
              table: table(1, '<img src=x onerror=alert(1)>'),
              files: 9,
              smallFiles: 9,
              smallBytes: 5400,
              estimatedAfter: 1,
            },
          ],
        }),
      ),
    );

    expect(view.titles().join('\n')).toContain('shop.<img src=x onerror=alert(1)>');
    expect(view.text()).toContain('<img src=x onerror=alert(1)>');
  });

  it('shows the new data when it arrives again, and ignores data it cannot read', () => {
    const { send, view } = start();
    send(message());
    send(message(sampleAdvisor({ merge: [] })));
    expect(view.cards()[5]).toEqual(['Merge candidates', '0', 'no table']);

    send({ type: 'advisor', data: { connection: 'x' } });
    expect(view.cards()[5]).toEqual(['Merge candidates', '0', 'no table']);
  });
});
