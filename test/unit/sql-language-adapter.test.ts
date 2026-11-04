import { afterEach, expect, it, vi } from 'vitest';
import { silentLogger } from '../../src/log';
import type { LanguageService } from '../../src/sql/language';

interface FakeDocument {
  readonly uri: { readonly scheme: string; toString(): string };
  readonly languageId: string;
  version: number;
  readonly isClosed: boolean;
  getText(): string;
  positionAt(offset: number): FakePosition;
  offsetAt(position: FakePosition): number;
}

interface FakePosition {
  readonly offset: number;
  isEqual(other: FakePosition): boolean;
}

interface CompletionProvider {
  provideCompletionItems(
    document: FakeDocument,
    position: FakePosition,
    token: { readonly isCancellationRequested: boolean },
  ): Promise<unknown>;
}

// The editor API as far as the syntax check and completion use it: the document events, the diagnostics, the
// completion provider, the active editor and the command that opens the suggestions.
const editor = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown) => void>();
  const marks = new Map<string, unknown[]>();
  const providers: { completion?: unknown } = {};
  const window: { activeTextEditor?: unknown } = {};
  const commands: string[] = [];
  const disposable = { dispose: () => undefined };
  const on = (name: string) => (listener: (event: unknown) => void) => {
    listeners.set(name, listener);
    return disposable;
  };
  class Disposable {
    static from(): Disposable {
      return new Disposable();
    }
    dispose(): void {}
  }
  class Range {
    constructor(
      readonly start: unknown,
      readonly end: unknown,
    ) {}
  }
  class Diagnostic {
    source = '';
    constructor(
      readonly range: unknown,
      readonly message: string,
    ) {}
  }
  class CompletionItem {
    constructor(readonly label: string) {}
  }
  class CompletionList {
    constructor(
      readonly items: unknown[],
      readonly isIncomplete: boolean,
    ) {}
  }
  const api = {
    Disposable,
    Range,
    Diagnostic,
    CompletionItem,
    CompletionList,
    CompletionItemKind: {},
    DiagnosticSeverity: { Error: 0 },
    CodeActionKind: { QuickFix: 'quickfix' },
    window,
    commands: {
      executeCommand: (command: string) => {
        commands.push(command);
        return Promise.resolve();
      },
    },
    languages: {
      registerCodeActionsProvider: () => disposable,
      registerCompletionItemProvider: (_selector: unknown, provider: unknown) => {
        providers.completion = provider;
        return disposable;
      },
      registerHoverProvider: () => disposable,
      registerSignatureHelpProvider: () => disposable,
      createDiagnosticCollection: () => ({
        has: (uri: { toString(): string }) => marks.has(uri.toString()),
        set: (uri: { toString(): string }, found: unknown[]) => void marks.set(uri.toString(), found),
        delete: (uri: { toString(): string }) => void marks.delete(uri.toString()),
        dispose: () => undefined,
      }),
    },
    workspace: {
      textDocuments: [],
      onDidOpenTextDocument: on('open'),
      onDidChangeTextDocument: on('change'),
      onDidCloseTextDocument: on('close'),
    },
  };
  return { api, listeners, marks, providers, window, commands, on };
});

vi.mock('vscode', () => editor.api);

const { registerSqlLanguage } = await import('../../src/sql/language.vscode');

afterEach(() => {
  vi.useRealTimers();
  editor.marks.clear();
  editor.commands.length = 0;
  delete editor.window.activeTextEditor;
});

const positionAt = (offset: number): FakePosition => ({
  offset,
  isEqual: (other) => other.offset === offset,
});

function textDocument(uri: string, languageId: string, text = 'SELEC 1'): FakeDocument {
  return {
    uri: { scheme: uri.split(':')[0] ?? '', toString: () => uri },
    languageId,
    version: 1,
    isClosed: false,
    getText: () => text,
    positionAt,
    offsetAt: (position) => position.offset,
  };
}

it('starts the syntax check only for a SQL document of a connection, and drops the marks of one that loses it', async () => {
  vi.useFakeTimers();
  const diagnose = vi.fn(() => Promise.resolve([{ offset: 0, length: 5, message: 'syntax error' }]));
  const connected = new Set<string>(['untitled:Untitled-1']);
  registerSqlLanguage({
    service: { diagnose } as unknown as LanguageService,
    logger: silentLogger,
    connectionOf: (opened: FakeDocument) => (connected.has(opened.uri.toString()) ? 'lake' : undefined),
    catalogOf: () => undefined,
    debounceMs: 300,
    onDidChangeConnection: editor.on('connection'),
  } as unknown as Parameters<typeof registerSqlLanguage>[0]);
  const fire = (name: string, event: unknown): void => editor.listeners.get(name)?.(event);
  const sql = textDocument('untitled:Untitled-1', 'sql');
  const notes = textDocument('file:///d/notes.md', 'markdown');
  const loose = textDocument('untitled:Untitled-2', 'sql');

  fire('open', notes);
  fire('change', { document: notes });
  fire('change', { document: loose });
  expect(vi.getTimerCount()).toBe(0);

  fire('change', { document: sql });
  fire('change', { document: sql });
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(300);
  expect(diagnose).toHaveBeenCalledTimes(1);
  expect(editor.marks.get(sql.uri.toString())).toHaveLength(1);

  connected.delete(sql.uri.toString());
  fire('connection', sql);
  expect(vi.getTimerCount()).toBe(0);
  expect(editor.marks.has(sql.uri.toString())).toBe(false);
  expect(diagnose).toHaveBeenCalledTimes(1);
});

it('marks the list incomplete while the columns of a view are read, and opens the suggestions again when the read ends while the text and the cursor stay', async () => {
  // Each request starts a read that the test ends, until the columns are known.
  const reads: (() => void)[] = [];
  let known = false;
  const complete = vi.fn(() =>
    Promise.resolve({
      insert: { offset: 9, length: 0 },
      replace: { offset: 9, length: 0 },
      items: [],
      pending: known ? undefined : new Promise<void>((resolve) => reads.push(resolve)),
    }),
  );
  registerSqlLanguage({
    service: { complete },
    logger: silentLogger,
    connectionOf: () => 'lake',
    catalogOf: () => undefined,
    debounceMs: 300,
  } as unknown as Parameters<typeof registerSqlLanguage>[0]);
  const provider = editor.providers.completion as CompletionProvider;
  const document = textDocument('untitled:Untitled-1', 'sql', 'select v. from sales.big_orders v');
  const cursor = positionAt(9);
  editor.window.activeTextEditor = { document, selection: { active: cursor } };
  const ask = () => provider.provideCompletionItems(document, cursor, { isCancellationRequested: false });
  const ended = () => new Promise((settled) => setTimeout(settled, 0));

  expect(await ask()).toMatchObject({ isIncomplete: true });
  expect(editor.commands).toEqual([]);
  reads[0]?.();
  await ended();
  expect(editor.commands).toEqual(['editor.action.triggerSuggest']);

  expect(await ask()).toMatchObject({ isIncomplete: true });
  document.version += 1;
  reads[1]?.();
  await ended();
  expect(editor.commands).toHaveLength(1);

  known = true;
  expect(await ask()).toEqual([]);
});
