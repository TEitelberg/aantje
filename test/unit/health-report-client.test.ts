import { beforeAll, describe, expect, it } from 'vitest';
import type { HealthEvent, HealthFinding, HealthSummary } from '../../src/health/model';
import { MAX_DEEP_FILES, applyEvents, freshData } from '../../src/health-report/model';
import type { HealthData, PanelEvent } from '../../src/health-report/model';
import { FakeNode } from '../support/fake-dom';
import { buildClientBundle, startPage } from '../support/page-harness';
import { customers, events, sampleFinding } from './health-report-support';

/**
 * Runs the real browser bundle against a stand-in for the DOM: the Health page shows the data it is sent and applies
 * the events that follow, narrows and expands its findings, posts only the requests that the extension accepts, and
 * keeps what the user chose while VS Code takes the page down. Counts, ids and structure are asserted, not wording.
 */

let bundle: string;
beforeAll(async () => {
  bundle = await buildClientBundle();
});

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

const idle = (): HealthData => freshData('Lake', lake, choice, 'idle');
const running = (): HealthData => freshData('Lake', lake, choice, 'running');
const whole = (data: HealthData) => ({ type: 'health', data });
const batch = (...list: PanelEvent[]) => ({ type: 'health', data: { events: list } });
const found = (...list: HealthFinding[]): HealthEvent[] =>
  list.map((finding) => ({ type: 'finding', finding }));

const orphan = sampleFinding('storage.file-orphaned', 'info', lake, {
  object: 'a',
  objectKey: 's3://b/stray.parquet',
  inspectSql: 'SELECT 1',
});
const small = sampleFinding('catalog.small-files', 'warning', events, { object: 'table:3' });
const missing = sampleFinding('storage.file-missing', 'error', customers, {
  object: 'data:7',
  objectKey: 's3://b/customers/one.parquet',
  inspectSql: 'SELECT * FROM __ducklake_metadata_lake.ducklake_data_file',
});
const endpoint = sampleFinding('connection.endpoint-with-path', 'warning', lake, {
  settingKey: 's3.endpoint',
});
const overdue = sampleFinding('catalog.cleanup-overdue', 'warning', lake);
const notSet = sampleFinding('connection.endpoint-not-set', 'error', lake, {
  settingKey: 's3.endpoint',
  suggestion: { endpoint: 'http://rustfs:9000', urlStyle: 'path', source: 'AWS_ENDPOINT_URL_S3' },
});
const noKeys = sampleFinding('connection.credentials-missing', 'warning', lake);
const five = [missing, small, orphan, endpoint, overdue];
const orphans = (count: number): HealthFinding[] =>
  Array.from({ length: count }, (_, index) =>
    sampleFinding('storage.file-orphaned', 'info', lake, { object: `k${String(index).padStart(3, '0')}` }),
  );

/** A finished run with these findings. */
function finished(
  findings: readonly HealthFinding[],
  changes: Partial<HealthData> = {},
  summaryChanges: Partial<HealthSummary> = {},
): HealthData {
  return {
    ...applyEvents(running(), [
      { type: 'group', status: { group: 'catalog', state: 'done' } },
      { type: 'group', status: { group: 'connection', state: 'done' } },
      { type: 'group', status: { group: 'storage', state: 'done' } },
      { type: 'group', status: { group: 'deep', state: 'skipped', reason: 'Not part of the quick check.' } },
      ...found(...findings),
      { type: 'summary', summary: summary(summaryChanges) },
      { type: 'snapshot', snapshot: 56 },
    ]),
    ...changes,
  };
}

function start(saved?: unknown) {
  const page = startPage(bundle, saved);
  const find = (predicate: (node: FakeNode) => boolean) => page.app().find(predicate);
  const view = {
    h1: () => find((node) => node.tag === 'h1'),
    subtitle: () => find((node) => node.hasClass('subtitle'))[0]?.textContent ?? '',
    button: (label: RegExp) => find((node) => node.tag === 'button' && label.test(node.textContent))[0],
    click: (label: RegExp) => view.button(label)?.fire('click'),
    pressed: (label: RegExp) => view.button(label)?.getAttribute('aria-pressed') === 'true',
    /** The value of each key figure. */
    cards: () => find((node) => node.hasClass('card')).map((card) => card.children[1]?.textContent),
    groups: () => find((node) => node.hasClass('groups'))[0]?.children.map((item) => item.textContent),
    verdict: () => find((node) => node.hasClass('verdict'))[0],
    findings: () => find((node) => node.tag === 'details' && node.hasClass('health-finding')),
    card: (finding: HealthFinding) =>
      view.findings().find((candidate) => candidate.textContent.includes(finding.title)) as FakeNode,
    /** The ids of these findings that the list shows. */
    shown: (...candidates: HealthFinding[]) =>
      candidates.filter((finding) => view.card(finding) !== undefined).map(({ id }) => id),
    sections: () => find((node) => node.tag === 'h2').map((node) => node.textContent),
    search: () => find((node) => node.tag === 'input' && node.type === 'search')[0] as FakeNode,
    number: () => find((node) => node.tag === 'input' && node.type === 'number')[0],
    type: (text: string) => {
      const input = view.search();
      input.value = text;
      input.fire('input');
    },
    enter: (files: string) => {
      const input = view.number() as FakeNode;
      input.value = files;
      input.fire('input');
    },
    /** The lines of what was and was not checked. */
    coverage: () => find((node) => node.hasClass('coverage'))[0]?.byTag('li').length,
    /** Presses every action button of a card and returns what was posted. */
    pressAll: (finding: HealthFinding): unknown[] => {
      const before = page.posted.length;
      view
        .card(finding)
        .byClass('actions')[0]
        ?.buttons()
        .forEach((button) => button.fire('click'));
      return page.posted.slice(before);
    },
    open: (finding: HealthFinding, open: boolean): FakeNode => {
      const card = view.card(finding);
      card.open = open;
      card.fire('toggle');
      return card;
    },
  };
  return { ...page, view };
}

describe('the Health page', () => {
  it('tells the extension that it is ready, ignores events before it has the data, and shows a finished run with its figures, sections, groups and findings', () => {
    const { posted, send, view, app } = start();
    expect(posted).toEqual([{ type: 'ready' }]);
    send(batch({ type: 'snapshot', snapshot: 5 }));
    expect(view.h1()).toHaveLength(0);

    send(whole(finished(five, {}, { errors: 1, warnings: 3, infos: 1, elapsedMs: 240 })));

    expect(view.h1()).toHaveLength(1);
    expect(view.subtitle()).toContain('@56');
    expect(view.verdict()?.hasClass('problems')).toBe(true);
    expect(view.cards()).toEqual(['1', '3', '1', '240 ms', '@56', '0']);
    expect(view.groups()).toHaveLength(4);
    expect(view.sections()).toEqual(['Lakehouse (3)', 'shop.customers (1)', 'shop.events (1)']);
    expect(
      view.findings().map((card) => ['error', 'warning', 'info'].find((severity) => card.hasClass(severity))),
    ).toEqual(['warning', 'warning', 'info', 'error', 'warning']);
    expect(view.coverage()).toBe(4);
    expect(app().find((node) => node.getAttribute('role') === 'status')).toHaveLength(1);
    expect(view.button(/^Run/)?.disabled).toBe(false);
    expect(view.button(/^Cancel/)).toBeUndefined();
  });

  it('posts a run with the depth and the number of files that were chosen, none for a number that is not valid, and follows the choice of a run that is going', () => {
    const { send, view, posted } = start();
    send(whole(idle()));
    expect(view.number()).toBeUndefined();
    view.click(/^Run/);
    expect(posted.at(-1)).toEqual({ type: 'action', action: 'run', depth: 'quick', deepFiles: 200 });

    view.click(/^Deep check/);
    expect(view.pressed(/^Deep check/)).toBe(true);
    expect(view.pressed(/^Quick/)).toBe(false);
    expect(view.number()?.value).toBe('200');
    for (const typed of ['0', '-3', '2.5', 'many', '', String(MAX_DEEP_FILES + 1)]) {
      const before = posted.length;
      view.enter(typed);
      view.click(/^Run/);
      expect(posted.length, typed).toBe(before);
      expect(view.number()?.getAttribute('aria-invalid'), typed).toBe('true');
    }
    view.enter('35');
    expect(view.number()?.getAttribute('aria-invalid')).toBe('false');
    view.click(/^Run/);
    expect(posted.at(-1)).toEqual({ type: 'action', action: 'run', depth: 'deep', deepFiles: 35 });
    view.enter(String(MAX_DEEP_FILES));
    view.click(/^Run/);
    expect(posted.at(-1)).toMatchObject({ depth: 'deep', deepFiles: MAX_DEEP_FILES });

    send(whole({ ...running(), depth: 'deep', deepFiles: 7 }));
    expect(view.pressed(/^Deep check/)).toBe(true);
    expect(view.number()?.value).toBe('7');
    expect(view.number()?.disabled).toBe(true);
  });

  it('offers Cancel instead of a second run while a check is going, posts it, and moves the focus back to Run when the run ends', () => {
    const { send, view, posted } = start();
    send(whole(idle()));
    view.click(/^Run/);
    send(whole(running()));
    expect(view.button(/^Run/)?.disabled).toBe(true);
    expect(view.button(/^Quick/)?.disabled).toBe(true);
    expect(FakeNode.active).toBe(view.button(/^Cancel/));

    view.click(/^Cancel/);
    expect(posted.at(-1)).toEqual({ type: 'action', action: 'cancel' });
    expect(view.button(/^Cancel/)?.disabled).toBe(true);

    send(batch({ type: 'summary', summary: summary({ cancelled: true }) }));
    expect(view.button(/^Cancel/)).toBeUndefined();
    expect(view.button(/^Run/)?.disabled).toBe(false);
    expect(FakeNode.active).toBe(view.button(/^Run/));
  });

  it('applies the events of a run as they arrive, keeps the open card and the filter text meanwhile, and starts over with a new run', () => {
    const { send, view } = start();
    send(whole(running()));
    expect(view.cards()).toEqual([]);
    expect(view.groups()).toHaveLength(4);
    expect(view.verdict()?.hasClass('running')).toBe(true);

    send(
      batch(
        { type: 'group', status: { group: 'catalog', state: 'done' } },
        { type: 'group', status: { group: 'deep', state: 'running' } },
        { type: 'progress', group: 'deep', done: 12, total: 200 },
        { type: 'group', status: { group: 'storage', state: 'failed', message: 'The listing timed out.' } },
      ),
    );
    expect(view.groups()?.[2]).toContain('The listing timed out.');
    expect(view.groups()?.[3]).toMatch(/12.*200/);

    send(batch(...found(missing)));
    view.open(missing, true);
    view.type('one.parquet');
    const box = view.search();
    send(batch(...found(orphan, small)));
    expect(view.search()).toBe(box);
    expect(view.search().value).toBe('one.parquet');
    expect(view.findings().map((card) => card.open)).toEqual([true]);
    expect(view.button(/^Error \(/)?.textContent).toContain('(1)');
    expect(view.button(/^Storage \(/)?.textContent).toContain('(2)');
    view.type('');
    expect(view.findings()).toHaveLength(3);

    send(
      batch(
        { type: 'summary', summary: summary({ errors: 1, warnings: 1, infos: 1, elapsedMs: 240 }) },
        { type: 'snapshot', snapshot: 56 },
      ),
    );
    expect(view.cards()).toEqual(['1', '1', '1', '240 ms', '@56', '0']);
    expect(view.subtitle()).toContain('@56');

    send(whole(running()));
    expect(view.findings()).toHaveLength(0);
    expect(view.cards()).toEqual([]);
  });

  it('judges a run that is over by its findings and its groups, counts what a limit left out, and names the reason of a failed start', () => {
    const { send, view } = start();
    send(whole(finished([])));
    expect(view.verdict()?.hasClass('healthy')).toBe(true);
    expect(view.coverage()).toBe(4);

    send(whole(finished([orphan], {}, { infos: 1 })));
    expect(view.verdict()?.hasClass('healthy')).toBe(true);
    expect(view.findings()).toHaveLength(1);

    send(whole(finished([overdue], { status: 'cancelled' }, { warnings: 1, cancelled: true })));
    expect(view.verdict()?.hasClass('problems')).toBe(true);

    send(
      whole(
        finished(
          [],
          {
            groups: [
              { group: 'catalog', state: 'done' },
              { group: 'storage', state: 'done', truncated: true, notChecked: 40, omitted: 20 },
            ],
          },
          { omitted: 20 },
        ),
      ),
    );
    expect(view.verdict()?.hasClass('healthy')).toBe(true);
    expect(view.cards().at(-1)).toBe('60');
    expect(view.coverage()).toBe(5);

    send(whole({ ...running(), status: 'failed', message: 'The connection is closed.' }));
    expect(view.verdict()?.hasClass('failed')).toBe(true);
    expect(view.verdict()?.textContent).toContain('The connection is closed.');
    expect(view.coverage()).toBeUndefined();
    expect(view.button(/^Run/)?.disabled).toBe(false);
  });

  it('narrows the list by severity, by group and by text whatever the case, and posts the filter with Open as Markdown', () => {
    const { send, view, posted } = start();
    send(whole(finished(five)));

    view.click(/^Warning \(/);
    expect(view.shown(...five)).toEqual([missing.id, orphan.id]);
    expect(view.pressed(/^Warning \(/)).toBe(false);
    expect(view.sections()).toEqual(['Lakehouse (1)', 'shop.customers (1)']);
    view.click(/^Warning \(/);
    expect(view.findings()).toHaveLength(5);

    view.click(/^Catalog \(/);
    expect(view.shown(...five)).toEqual([missing.id, orphan.id, endpoint.id]);
    view.click(/^Catalog \(/);

    view.type('ONE.PARQUET');
    expect(view.shown(...five)).toEqual([missing.id]);
    view.type('shop.events');
    expect(view.shown(...five)).toEqual([small.id]);
    view.type('fix of connection.endpoint');
    expect(view.shown(...five)).toEqual([endpoint.id]);
    view.type('zebra');
    expect(view.findings()).toHaveLength(0);
    view.type('');
    expect(view.findings()).toHaveLength(5);

    view.click(/^Info \(/);
    view.type('file');
    view.click(/Markdown/);
    const last = posted.at(-1) as {
      type: string;
      view: { text: string; severities: string[]; groups: string[] };
    };
    expect(last.type).toBe('markdown');
    expect(last.view.text).toBe('file');
    expect(last.view.severities).toEqual(['error', 'warning']);
    expect(last.view.groups.toSorted()).toEqual(['catalog', 'connection', 'deep', 'storage']);
  });

  it('expands a card to its detail and SQL, remembers which cards are open, and posts each action of a finding with its id and nothing else', () => {
    const { send, view, saved } = start();
    send(whole(finished([...five, notSet, noKeys], {}, { errors: 2, warnings: 4, infos: 1 })));
    expect(view.card(missing).open).toBe(false);

    const card = view.open(missing, true);
    const body = card.byClass('body')[0] as FakeNode;
    expect(body.byTag('dd').map((node) => node.textContent)).toEqual(
      expect.arrayContaining([missing.detail, missing.cause, missing.fix, 's3://b/customers/one.parquet']),
    );
    expect(body.byTag('pre')[0]?.textContent).toBe(missing.inspectSql);
    expect((saved() as { expanded: string[] }).expanded).toEqual([missing.id]);
    view.open(missing, false);
    expect((saved() as { expanded: string[] }).expanded).toEqual([]);

    const action = (name: string, finding: HealthFinding) => ({
      type: 'action',
      action: name,
      finding: finding.id,
    });
    expect(view.pressAll(missing)).toEqual([
      action('inspect', missing),
      action('revealTable', missing),
      action('showStatistics', missing),
    ]);
    expect(view.pressAll(small)).toEqual([
      action('script', small),
      action('revealTable', small),
      action('showStatistics', small),
    ]);
    expect(view.pressAll(orphan)).toEqual([action('inspect', orphan), action('script', orphan)]);
    expect(view.pressAll(endpoint)).toEqual([action('setting', endpoint)]);
    expect(view.pressAll(overdue)).toEqual([action('script', overdue)]);
    expect(view.pressAll(notSet)).toEqual([
      action('useEndpoint', notSet),
      action('setCredentials', notSet),
      action('setting', notSet),
    ]);
    expect(view.pressAll(noKeys)).toEqual([action('setCredentials', noKeys)]);
  });

  it('disables the actions that write settings or credentials while a check runs, leaves the others, and enables them when the run ends', () => {
    const { send, view } = start();
    send(whole({ ...finished([notSet]), status: 'running' }));
    const disabled = () =>
      view
        .card(notSet)
        .byClass('actions')[0]
        ?.buttons()
        .map((button) => button.disabled);

    expect(disabled()).toEqual([true, true, false]);
    send(batch({ type: 'summary', summary: summary({ errors: 1 }) }));
    expect(disabled()).toEqual([false, false, false]);
    send(whole({ ...finished([notSet]), status: 'running' }));
    expect(disabled()).toEqual([true, true, false]);
  });

  it('shows the first hundred findings, more on request, and a hundred again when the text of the filter or the run changes', () => {
    const { send, view } = start();
    send(whole(finished(orphans(100))));
    expect(view.findings()).toHaveLength(100);
    expect(view.button(/^Show more/)).toBeUndefined();

    // The section of the table does not start when the hundred are used up by the sections before it.
    send(whole(finished([...orphans(100), small])));
    expect(view.sections()).toEqual(['Lakehouse (100)']);
    expect(view.button(/^Show more/)).toBeDefined();

    send(whole(finished(orphans(250), {}, { infos: 250 })));
    expect(view.findings()).toHaveLength(100);
    expect(view.sections()).toEqual(['Lakehouse (250)']);
    view.click(/^Show more/);
    expect(view.findings()).toHaveLength(200);
    view.click(/^Warning \(/);
    expect(view.findings()).toHaveLength(200);
    view.click(/^Show more/);
    expect(view.findings()).toHaveLength(250);
    expect(view.button(/^Show more/)).toBeUndefined();

    view.type('k');
    expect(view.findings()).toHaveLength(100);
    view.click(/^Show more/);
    expect(view.findings()).toHaveLength(200);
    send(whole(running()));
    send(batch(...found(...orphans(250))));
    expect(view.findings()).toHaveLength(100);
    expect(view.button(/^Info \(/)?.textContent).toContain('(250)');
  });

  it('keeps the filter, the open cards and the depth for the same panel; another panel, a running check and a state it cannot read start from the defaults', () => {
    const first = start();
    first.send(whole(finished([missing, small])));
    first.view.click(/^Info \(/);
    first.view.type('one.parquet');
    first.view.open(missing, true);
    first.view.click(/^Deep check/);
    first.view.enter('35');

    const second = start(first.saved());
    second.send(whole(finished([missing, small])));
    expect(second.view.search().value).toBe('one.parquet');
    expect(second.view.pressed(/^Info \(/)).toBe(false);
    expect(second.view.pressed(/^Deep check/)).toBe(true);
    expect(second.view.number()?.value).toBe('35');
    expect(second.view.findings().map((card) => card.open)).toEqual([true]);

    const third = start(first.saved());
    third.send(whole({ ...finished([missing]), scope: events }));
    expect(third.view.search().value).toBe('');
    expect(third.view.findings()).toHaveLength(1);

    const fourth = start(first.saved());
    fourth.send(whole(running()));
    expect(fourth.view.pressed(/^Quick/)).toBe(true);
    expect(fourth.view.number()).toBeUndefined();

    const fifth = start({ identity: 3, filter: 'x' });
    fifth.send(whole(finished([missing])));
    expect(fifth.view.findings()).toHaveLength(1);
    expect(fifth.view.search().value).toBe('');
  });

  it('shows hostile names and texts from the catalog as text, never as markup', () => {
    const name = '<img src=x onerror=alert(1)>';
    const hostile = sampleFinding(
      'storage.file-missing',
      'error',
      { kind: 'table', id: 9, schema: '"><script>', name },
      {
        object: 'data:1',
        title: '<b>bold</b> & "quoted"',
        detail: '<a href="http://evil">click</a>',
        objectKey: '<svg onload=alert(1)>',
        inspectSql: '</pre><script>alert(1)</script>',
      },
    );
    const { send, view, app } = start();
    send(whole(finished([hostile], {}, { errors: 1 })));

    expect(view.sections()).toEqual([`"><script>.${name} (1)`]);
    const card = view.open(hostile, true);
    expect(card.textContent).toContain('<a href="http://evil">click</a>');
    expect(card.textContent).toContain('<svg onload=alert(1)>');
    expect(card.byTag('pre')[0]?.textContent).toBe('</pre><script>alert(1)</script>');
    expect(app().find((node) => ['img', 'script', 'b', 'a', 'svg'].includes(node.tag))).toEqual([]);
    expect(app().find((node) => 'innerHTML' in node || 'outerHTML' in node)).toEqual([]);
  });
});
