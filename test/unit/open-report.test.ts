import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile } from '../../src/connections/profile';
import { AantjeError } from '../../src/errors';
import type { Logger } from '../../src/log';
import type { ReportHostEnv, ReportSpec } from '../../src/shell/host.vscode';
import type { ReportKind } from '../../src/shell/panels';

/** The parts of the editor that the report host touches, recorded. */
const editor = vi.hoisted(() => {
  interface FakePanel {
    title: string;
    posted: unknown[];
    revealed: number;
    disposed: boolean;
    readonly receive: { current: (message: unknown) => void };
    readonly closed: { current: () => void };
  }
  return {
    panels: [] as FakePanel[],
    information: [] as string[],
    errors: [] as string[],
    progress: [] as { title: string; cancellable: boolean | undefined }[],
    listening: { count: 0 },
  };
});

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (base: unknown, ...parts: string[]) => ({ base, parts, toString: () => parts.join('/') }),
  },
  ViewColumn: { Active: -1 },
  ProgressLocation: { Notification: 15 },
  window: {
    createWebviewPanel: (_viewType: string, title: string) => {
      const panel = {
        title,
        posted: [] as unknown[],
        revealed: 0,
        disposed: false,
        receive: { current: (_message: unknown): void => undefined },
        closed: { current: (): void => undefined },
        webview: {
          html: '',
          asWebviewUri: () => ({ toString: () => 'vscode-resource:/report-client.js' }),
          postMessage: (message: unknown) => panel.posted.push(message),
          onDidReceiveMessage: (listener: (message: unknown) => void) =>
            void (panel.receive.current = listener),
        },
        reveal: () => void (panel.revealed += 1),
        dispose: () => {
          panel.disposed = true;
          panel.closed.current();
        },
        onDidDispose: (listener: () => void) => void (panel.closed.current = listener),
      };
      editor.panels.push(panel);
      return panel;
    },
    withProgress: (
      options: { title: string; cancellable?: boolean },
      task: (progress: unknown, token: unknown) => Promise<unknown>,
    ) => {
      editor.progress.push({ title: options.title, cancellable: options.cancellable });
      const token = {
        onCancellationRequested: () => {
          editor.listening.count += 1;
          return { dispose: () => void (editor.listening.count -= 1) };
        },
      };
      return task({}, token);
    },
    showInformationMessage: (message: string) => {
      editor.information.push(message);
      return Promise.resolve(undefined);
    },
    showErrorMessage: (message: string) => {
      editor.errors.push(message);
      return Promise.resolve(undefined);
    },
  },
}));

const { markStaleOnRefresh, openReport } = await import('../../src/shell/host.vscode');

interface Data {
  readonly rows: readonly string[];
}
type Action = { readonly type: 'action'; readonly action: 'open'; readonly row: string };

const kind: ReportKind<Data, Action, never> = {
  viewType: 'aantje.test',
  css: '',
  message: (data) => ({ type: 'test', data }),
  isAction: (value): value is Action =>
    typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'action',
  isView: (_value): _value is never => false,
  toMarkdown: () => '',
};

const profile = { id: 'lake-1', name: 'Lake' } as ConnectionProfile;

function setup(options: { connected?: boolean; profiles?: ConnectionProfile[] } = {}) {
  const warnings: string[] = [];
  const failures: string[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => void warnings.push(message),
    error: (message) => void failures.push(message),
  };
  const selected: string[] = [];
  const reads: { params: { readonly name: string; readonly at?: number }; signal: AbortSignal }[] = [];
  const performed: string[] = [];
  const known = options.profiles ?? [profile];
  const refreshListeners: ((connectionId: string) => void)[] = [];
  const env = {
    tree: {
      reader: () => (options.connected === false ? undefined : {}),
      onDidRefresh: (listener: (connectionId: string) => void) => {
        refreshListeners.push(listener);
        return { dispose: () => void refreshListeners.splice(refreshListeners.indexOf(listener), 1) };
      },
    },
    store: { get: (id: string) => known.find((candidate) => candidate.id === id) },
    logger,
    extensionUri: { toString: () => 'file:///extension' },
    active: { select: (id: string) => void selected.push(id) },
  } as unknown as ReportHostEnv;
  const spec: ReportSpec<
    Data,
    Action,
    never,
    { readonly row: string },
    { readonly name: string; readonly at?: number }
  > = {
    command: 'aantje.showTest',
    kind,
    noun: 'test report',
    goal: 'show its test',
    keyOf: (owner, { name }) => JSON.stringify([owner.id, name]),
    open: (_reader, owner, params) => ({
      progress: `Reading ${params.name}...`,
      read: (signal) => {
        reads.push({ params, signal });
        // A subject that does not exist at the snapshot.
        if (params.name === 'gone') return Promise.resolve(null);
        return Promise.resolve({ rows: [`row ${reads.length}`, 'boom'] });
      },
      title: (data) => `Test ${params.name} (${data.rows[0]}) · ${owner.name}`,
      absent: `There is no ${params.name}.`,
    }),
    // `at` is the snapshot of the first read; a Refresh reads at the newest.
    refreshParams: ({ name }) => ({ name }),
    planAction: (data, action) => (data.rows.includes(action.row) ? { row: action.row } : undefined),
    perform: (plan) => {
      performed.push(plan.row);
      if (plan.row === 'boom') throw new AantjeError('QUERY_FAILED', 'The row cannot be opened.');
      return Promise.resolve();
    },
  };
  const report = openReport(env, spec);
  const page = () => editor.panels[0]!;
  const send = (message: unknown) => page().receive.current(message);
  const refreshed = (connectionId: string) => refreshListeners.forEach((listener) => listener(connectionId));
  return { report, page, send, selected, reads, performed, warnings, failures, known, refreshed };
}

beforeEach(() => {
  editor.panels.length = 0;
  editor.information.length = 0;
  editor.errors.length = 0;
  editor.progress.length = 0;
  editor.listening.count = 0;
});

describe('markStaleOnRefresh', () => {
  it('marks the panels that the report names for the refreshed connection and no others, until it is disposed', () => {
    const listeners: ((connectionId: string) => void)[] = [];
    const tree = {
      onDidRefresh: (listener: (connectionId: string) => void) => {
        listeners.push(listener);
        return { dispose: () => void listeners.splice(listeners.indexOf(listener), 1) };
      },
    };
    const marked: string[] = [];
    const panels = { markStale: (key: string) => void marked.push(key) };
    const owner = new Map([
      ['lake-1', ['a', 'b']],
      ['lake-2', ['c']],
    ]);

    const watch = markStaleOnRefresh(tree, panels, (connectionId) => owner.get(connectionId) ?? []);
    listeners.forEach((listener) => listener('lake-1'));
    listeners.forEach((listener) => listener('unknown'));
    expect(marked).toEqual(['a', 'b']);

    watch.dispose();
    expect(listeners).toHaveLength(0);
  });
});

describe('openReport', () => {
  it('says that the subject is gone instead of opening a panel, and refreshes with the parameters the report gives', async () => {
    const { report, send, reads } = setup();
    await report.show(profile, { name: 'gone' });
    expect(editor.panels).toHaveLength(0);
    expect(editor.information).toEqual(['There is no gone.']);

    await report.show(profile, { name: 'a', at: 5 });
    send({ type: 'ready' });
    send({ type: 'refresh' });
    await vi.waitFor(() => expect(reads).toHaveLength(3));
    expect(reads[2]?.params).toEqual({ name: 'a' });
    expect(editor.panels).toHaveLength(1);
  });

  it('tells the panels of a refreshed connection, and only those, that their data is out of date, until new data arrives', async () => {
    const { report, send, refreshed } = setup();
    await report.show(profile, { name: 'a' });
    send({ type: 'ready' });
    const posted = () => editor.panels[0]?.posted ?? [];

    refreshed('another-lake');
    expect(posted()).toHaveLength(1);

    refreshed('lake-1');
    expect(posted().at(-1)).toEqual({ type: 'stale' });

    await report.show(profile, { name: 'a' });
    expect(posted().at(-1)).toMatchObject({ type: 'test' });

    report.dispose();
    refreshed('lake-1');
    expect(posted().filter((message) => (message as { type: string }).type === 'stale')).toHaveLength(1);
  });

  it('reads under a cancellable notification with the progress text of the spec, releases the Cancel listener, titles the panel after the data, selects the connection and posts the data once the page is ready', async () => {
    const { report, page, send, selected } = setup();

    await report.show(profile, { name: 'a' });

    expect(editor.progress).toEqual([{ title: 'Reading a...', cancellable: true }]);
    expect(editor.listening.count).toBe(0);
    expect(page().title).toBe('Test a (row 1) · Lake');
    expect(selected).toEqual(['lake-1']);
    send({ type: 'ready' });
    expect(page().posted).toEqual([{ type: 'test', data: { rows: ['row 1', 'boom'] } }]);
  });

  it('asks to connect first, and opens no panel, for a connection that is not open', async () => {
    const { report } = setup({ connected: false });

    await report.show(profile, { name: 'a' });

    expect(editor.information).toHaveLength(1);
    expect(editor.panels).toHaveLength(0);
  });

  it('shows the same key in the same panel and a new key in a new one', async () => {
    const { report } = setup();

    await report.show(profile, { name: 'a' });
    await report.show(profile, { name: 'a' });
    await report.show(profile, { name: 'b' });

    expect(editor.panels.map((panel) => panel.title)).toEqual([
      'Test a (row 2) · Lake',
      'Test b (row 3) · Lake',
    ]);
    expect(editor.panels[0]?.revealed).toBe(1);
  });

  it('reads again with the parameters of the panel when the page asks for a refresh', async () => {
    const { report, reads, page } = setup();
    await report.show(profile, { name: 'a' });
    await report.show(profile, { name: 'b' });
    editor.progress.length = 0;

    editor.panels[0]?.receive.current({ type: 'refresh' });
    await vi.waitFor(() => expect(reads).toHaveLength(3));

    expect(reads[2]?.params).toEqual({ name: 'a' });
    expect(editor.progress).toEqual([{ title: 'Reading a...', cancellable: true }]);
    await vi.waitFor(() => expect(page().title).toBe('Test a (row 3) · Lake'));
  });

  it('runs an action that the data offers, ignores one it does not offer with a log line, and reports a failing one like a command', async () => {
    const { report, send, performed, warnings, failures } = setup();
    await report.show(profile, { name: 'a' });

    send({ type: 'action', action: 'open', row: 'row 1' });
    await vi.waitFor(() => expect(performed).toEqual(['row 1']));

    send({ type: 'action', action: 'open', row: 'row 99' });
    expect(performed).toEqual(['row 1']);
    expect(warnings).toHaveLength(1);

    send({ type: 'action', action: 'open', row: 'boom' });
    await vi.waitFor(() => expect(editor.errors).toEqual(['The row cannot be opened.']));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('aantje.showTest');
  });

  it('answers a refresh or an action of a panel whose connection was removed with a hint, without reading or acting', async () => {
    const { report, send, performed, known, reads } = setup();
    await report.show(profile, { name: 'a' });
    known.length = 0;

    send({ type: 'refresh' });
    send({ type: 'action', action: 'open', row: 'row 1' });

    expect(editor.information).toHaveLength(2);
    expect(performed).toEqual([]);
    expect(reads).toHaveLength(1);
  });

  it('closes its panels on dispose', async () => {
    const { report } = setup();
    await report.show(profile, { name: 'a' });
    await report.show(profile, { name: 'b' });

    report.dispose();

    expect(editor.panels.map((panel) => panel.disposed)).toEqual([true, true]);
  });
});
