import * as vscode from 'vscode';
import { failureLog, withFallback } from '../log-once';
import type { FailureLog } from '../log-once';
import type { Logger } from '../log';
import { EMPTY_CATALOG } from './catalog';
import type { SqlCatalog } from './catalog';
import type { CompletionKind } from './completion-env';
import { isSqlDocument, SQL_SELECTOR } from './glue.vscode';
import type { LanguageService } from './language';
import { quickFixes } from './problems';
import type { Problem } from './problems';

interface SqlLanguageDeps {
  readonly service: LanguageService;
  readonly logger: Logger;
  /** The connection id of the document; a document without a connection gets no language features. */
  connectionOf(document: vscode.TextDocument): string | undefined;
  /** The catalog at the editor's snapshot; undefined while disconnected, so names are not completed. */
  catalogOf(document: vscode.TextDocument): SqlCatalog | undefined;
  /** Wait after the last keystroke before the syntax check. */
  readonly debounceMs: number;
  /** Fires when a document gains or loses its connection. */
  readonly onDidChangeConnection?: vscode.Event<vscode.TextDocument>;
  /** Fires when the catalogs may have changed: the documents are checked again. */
  readonly onDidChangeCatalog?: vscode.Event<unknown>;
}

// The problems that the marks of a document show, at the version they were found for: the quick fixes edit by them.
type Marks = Map<string, { readonly version: number; readonly shown: readonly Mark[] }>;

interface Mark {
  readonly diagnostic: vscode.Diagnostic;
  readonly problem: Problem;
}

// A function, not a constant: unit tests load this file before the editor API exists.
const kinds = (): Record<CompletionKind, vscode.CompletionItemKind> => ({
  keyword: vscode.CompletionItemKind.Keyword,
  function: vscode.CompletionItemKind.Function,
  type: vscode.CompletionItemKind.TypeParameter,
  schema: vscode.CompletionItemKind.Module,
  table: vscode.CompletionItemKind.Class,
  view: vscode.CompletionItemKind.Interface,
  column: vscode.CompletionItemKind.Field,
  macro: vscode.CompletionItemKind.Method,
  snapshot: vscode.CompletionItemKind.Event,
  setting: vscode.CompletionItemKind.Property,
  snippet: vscode.CompletionItemKind.Snippet,
  parameter: vscode.CompletionItemKind.Variable,
  hint: vscode.CompletionItemKind.Issue,
});

const markdown = (text: string): vscode.MarkdownString => new vscode.MarkdownString(text);

const rangeOf = (document: vscode.TextDocument, offset: number, length: number): vscode.Range =>
  new vscode.Range(document.positionAt(offset), document.positionAt(offset + length));

/** Registers completion, hover, signature help, the marks of the check while typing and their quick fixes. */
export function registerSqlLanguage(deps: SqlLanguageDeps): vscode.Disposable {
  const { service } = deps;
  const failed = failureLog(deps.logger);
  const answer = <T>(feature: string, pending: Promise<T | undefined>): Promise<T | undefined> =>
    withFallback(failed, feature, pending, undefined);
  const catalogOf = (document: vscode.TextDocument): SqlCatalog => deps.catalogOf(document) ?? EMPTY_CATALOG;

  const completion = vscode.languages.registerCompletionItemProvider(
    SQL_SELECTOR,
    {
      async provideCompletionItems(document, position, token) {
        if (deps.connectionOf(document) === undefined) return undefined;
        const result = await answer(
          'Completion',
          service.complete(document.getText(), document.offsetAt(position), catalogOf(document)),
        );
        if (!result || token.isCancellationRequested) return undefined;
        const range = {
          inserting: rangeOf(document, result.insert.offset, result.insert.length),
          replacing: rangeOf(document, result.replace.offset, result.replace.length),
        };
        const kindOf = kinds();
        const items = result.items.map((item) => {
          const shown = new vscode.CompletionItem(item.label, kindOf[item.kind]);
          shown.insertText = item.snippet ? new vscode.SnippetString(item.insertText) : item.insertText;
          shown.range = range;
          shown.sortText = item.sortText;
          if (item.filterText !== undefined) shown.filterText = item.filterText;
          if (item.detail !== undefined) shown.detail = item.detail;
          if (item.documentation !== undefined) shown.documentation = markdown(item.documentation);
          return shown;
        });
        if (!result.pending) return items;
        // The columns of a view are still being read: VS Code asks again at every keystroke, and the list opens again
        // when the read ends.
        suggestAgain(document, position, result.pending);
        return new vscode.CompletionList(items, true);
      },
    },
    '.',
    '"',
    // Opens the snapshot times inside `TIMESTAMP => '`; elsewhere a string gets nothing.
    "'",
  );

  const hover = vscode.languages.registerHoverProvider(SQL_SELECTOR, {
    async provideHover(document, position) {
      if (deps.connectionOf(document) === undefined) return undefined;
      const result = await answer(
        'Hover',
        service.hover(document.getText(), document.offsetAt(position), catalogOf(document)),
      );
      return (
        result &&
        new vscode.Hover(
          markdown(result.markdown),
          rangeOf(document, result.range.offset, result.range.length),
        )
      );
    },
  });

  const signature = vscode.languages.registerSignatureHelpProvider(
    SQL_SELECTOR,
    {
      async provideSignatureHelp(document, position) {
        if (deps.connectionOf(document) === undefined) return undefined;
        const result = await answer(
          'Signature help',
          service.signature(document.getText(), document.offsetAt(position), catalogOf(document)),
        );
        if (!result) return undefined;
        const help = new vscode.SignatureHelp();
        help.signatures = result.signatures.map(({ label, documentation, parameters }) => {
          const information = new vscode.SignatureInformation(
            label,
            documentation && markdown(documentation),
          );
          information.parameters = parameters.map((parameter) => new vscode.ParameterInformation(parameter));
          return information;
        });
        help.activeSignature = result.activeSignature;
        help.activeParameter = result.activeParameter;
        return help;
      },
    },
    '(',
    ',',
  );

  const marks: Marks = new Map();
  return vscode.Disposable.from(completion, hover, signature, checks(deps, failed, marks), fixes(marks));
}

// Only while the editor still shows the text and the cursor of the request; a request never waits for the read.
function suggestAgain(
  document: vscode.TextDocument,
  position: vscode.Position,
  pending: Promise<void>,
): void {
  const { version } = document;
  const reopen = (): void => {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document !== document || document.version !== version) return;
    if (!editor.selection.active.isEqual(position)) return;
    void vscode.commands.executeCommand('editor.action.triggerSuggest');
  };
  void pending.then(reopen, () => undefined);
}

function checks(deps: SqlLanguageDeps, failed: FailureLog, marks: Marks): vscode.Disposable {
  const { service, debounceMs, onDidChangeConnection, onDidChangeCatalog } = deps;
  const collection = vscode.languages.createDiagnosticCollection('aantje-sql');
  const timers = new Map<string, NodeJS.Timeout>();
  const forget = (uri: vscode.Uri): void => {
    collection.delete(uri);
    marks.delete(uri.toString());
  };
  const applies = (document: vscode.TextDocument): boolean =>
    isSqlDocument(document) && deps.connectionOf(document) !== undefined;

  const check = async (document: vscode.TextDocument): Promise<void> => {
    if (!applies(document)) {
      forget(document.uri);
      return;
    }
    const { version } = document;
    // Without a catalog (not connected, still connecting) only the syntax is checked.
    const found = await withFallback(
      failed,
      'Syntax check',
      service.diagnose(document.getText(), document.uri.toString(), deps.catalogOf(document)),
      undefined,
    );
    // `undefined` or a changed version means a newer text replaces this answer; a closed document keeps no marks.
    if (found === undefined || document.version !== version || document.isClosed) return;
    const shown = found.map((problem) => ({ problem, diagnostic: diagnosticOf(document, problem) }));
    marks.set(document.uri.toString(), { version, shown });
    collection.set(
      document.uri,
      shown.map(({ diagnostic }) => diagnostic),
    );
  };
  // Every keystroke in every document passes here: only a SQL document of a connection starts a check.
  const schedule = (document: vscode.TextDocument): void => {
    const key = document.uri.toString();
    clearTimeout(timers.get(key));
    timers.delete(key);
    if (!applies(document)) {
      if (collection.has(document.uri)) forget(document.uri);
      return;
    }
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void check(document);
      }, debounceMs),
    );
  };

  vscode.workspace.textDocuments.forEach(schedule);
  return vscode.Disposable.from(
    collection,
    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidChangeTextDocument(({ document }) => schedule(document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      clearTimeout(timers.get(document.uri.toString()));
      timers.delete(document.uri.toString());
      forget(document.uri);
    }),
    ...(onDidChangeConnection ? [onDidChangeConnection(schedule)] : []),
    ...(onDidChangeCatalog
      ? [onDidChangeCatalog(() => vscode.workspace.textDocuments.forEach(schedule))]
      : []),
    new vscode.Disposable(() => timers.forEach((timer) => clearTimeout(timer))),
  );
}

function diagnosticOf(document: vscode.TextDocument, problem: Problem): vscode.Diagnostic {
  const severity =
    problem.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
  const diagnostic = new vscode.Diagnostic(
    rangeOf(document, problem.offset, problem.length),
    problem.message,
    severity,
  );
  diagnostic.source = 'aantje';
  return diagnostic;
}

// Offers the names that a warning names as nearest, for the marks of the text as it is now.
function fixes(marks: Marks): vscode.Disposable {
  return vscode.languages.registerCodeActionsProvider(
    SQL_SELECTOR,
    {
      provideCodeActions(document, _range, context) {
        const marked = marks.get(document.uri.toString());
        if (marked?.version !== document.version) return [];
        return context.diagnostics.flatMap((diagnostic) => {
          const mark = marked.shown.find((candidate) => sameMark(candidate.diagnostic, diagnostic));
          return mark ? actionsOf(document, mark) : [];
        });
      },
    },
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
  );
}

const sameMark = (a: vscode.Diagnostic, b: vscode.Diagnostic): boolean =>
  a === b || (a.source === b.source && a.message === b.message && a.range.isEqual(b.range));

function actionsOf(document: vscode.TextDocument, { diagnostic, problem }: Mark): vscode.CodeAction[] {
  return quickFixes(problem).map((fix, index) => {
    const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, rangeOf(document, fix.offset, fix.length), fix.text);
    action.diagnostics = [diagnostic];
    action.isPreferred = index === 0;
    return action;
  });
}
