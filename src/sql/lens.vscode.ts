import * as vscode from 'vscode';
import { registerGuarded } from '../command.vscode';
import { isCount, isOptional, isShape, isString } from '../guards';
import type { Logger } from '../log';
import { failureLog, withFallback } from '../log-once';
import type { EditorRef, QueryEditors, RunScript } from './editor';
import { activeSqlEditor, documentOfKey, SQL_SELECTOR } from './glue.vscode';
import type { LanguageService } from './language';
import { actionPrefix, actionSql, cteRowLimitOf, lensStatements, statementOf } from './lens';
import type { LensAction } from './lens';
import type { SqlToken } from './tokens';
import { profiler } from './profile';
import { statementSpans } from './script';

interface LensEnv {
  readonly editors: QueryEditors;
  readonly service: LanguageService;
  readonly logger: Logger;
  readonly editorOf: (document: vscode.TextDocument) => EditorRef;
  readonly connectionOf: (document: vscode.TextDocument) => string | undefined;
}

/** What a lens passes to its command; the command reads the document again, so an edit since cannot run stale text. */
interface LensArgs {
  readonly uri: string;
  /** Where the statement starts. */
  readonly offset: number;
  /** The CTE of the statement's lens list, and its name to check that it is still the same. */
  readonly cte?: number;
  readonly name?: string;
}

const isLensArgs = isShape({
  uri: isString,
  offset: isCount,
  cte: isOptional(isCount),
  name: isOptional(isString),
}) as (value: unknown) => value is LensArgs;

/** A statement to act on: its text, where it starts, whether it only reads, and whether aantje built it (a CTE). */
interface Target {
  readonly document: vscode.TextDocument;
  readonly text: string;
  readonly base: number;
  readonly readsOnly: boolean;
  readonly cte: boolean;
}

const LABELS: Readonly<Record<LensAction, string>> = {
  execute: 'Execute',
  explain: 'Explain',
  analyze: 'Analysis',
  profile: 'Statistics',
};

const COMMANDS: Readonly<Record<LensAction, string>> = {
  execute: 'aantje.runStatement',
  explain: 'aantje.explainStatement',
  analyze: 'aantje.analyzeStatement',
  profile: 'aantje.profileStatement',
};

const settings = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('aantje');
const lensesOn = (): boolean => settings().get<unknown>('sql.codeLens') !== false;
const cteRowLimit = (): number => cteRowLimitOf(settings().get<unknown>('sql.cteRowLimit'));

/** The lenses of a document: Execute | Explain | Analysis | Statistics above each query, and above each of its CTEs. */
function lensesOf(
  document: vscode.TextDocument,
  text: string,
  tokens: readonly SqlToken[],
  limit: number,
): vscode.CodeLens[] {
  const uri = document.uri.toString();
  return lensStatements(text, tokens).flatMap((statement) => {
    const at = document.positionAt(statement.start);
    const range = new vscode.Range(at, at);
    const args: LensArgs = { uri, offset: statement.start };
    const lens = (action: LensAction, tooltip: string): vscode.CodeLens =>
      new vscode.CodeLens(range, {
        title: LABELS[action],
        command: COMMANDS[action],
        arguments: [args],
        tooltip,
      });
    // A view or a macro stores its query: only its CTEs get lenses.
    const lenses = statement.query
      ? [
          lens('execute', 'Runs the statement, as Run Statement at Cursor does'),
          lens('explain', 'Shows the plan of the statement (EXPLAIN); runs nothing'),
          ...(statement.readsOnly
            ? [
                lens(
                  'analyze',
                  'Runs the statement and shows the plan with time and rows per operator (EXPLAIN ANALYZE)',
                ),
              ]
            : []),
          lens('profile', 'Runs the statement with DuckDB’s profiler and shows its figures'),
        ]
      : [];
    // The lines that hold a row of lenses: the statement's own (unless a view) and one per CTE.
    const rows = [
      ...(statement.query ? [at.line] : []),
      ...statement.ctes.map(({ start }) => document.positionAt(start).line),
    ];
    statement.ctes.forEach((cte, index) => {
      const start = document.positionAt(cte.start);
      const cteRange = new vscode.Range(start, start);
      const cteArgs: LensArgs = { uri, offset: statement.start, cte: index, name: cte.name };
      // Lenses that share a line run on in one row: the name of the CTE tells them apart.
      const prefix = rows.filter((line) => line === start.line).length > 1 ? `CTE ${cte.name}: ` : '';
      const cteLens = (action: LensAction, title: string, tooltip: string): vscode.CodeLens =>
        new vscode.CodeLens(cteRange, { title, command: COMMANDS[action], arguments: [cteArgs], tooltip });
      lenses.push(
        cteLens(
          'execute',
          `${prefix}Execute (LIMIT ${limit})`,
          `Runs the CTE ${cte.name} on its own, the first ${limit} rows`,
        ),
        cteLens('explain', 'Explain', `Shows the plan of the CTE ${cte.name} on its own; runs nothing`),
        cteLens(
          'analyze',
          'Analysis',
          `Runs the CTE ${cte.name} on its own and shows its plan with time and rows`,
        ),
        cteLens('profile', 'Statistics', `Runs the CTE ${cte.name} on its own with DuckDB’s profiler`),
      );
    });
    return lenses;
  });
}

const info = (message: string): void => void vscode.window.showInformationMessage(message);

/** The statement or CTE a lens points to, read again from the document. */
async function lensTarget(service: LanguageService, args: LensArgs): Promise<Target | undefined> {
  const document = documentOfKey(args.uri);
  if (!document) return undefined;
  const text = document.getText();
  const statement = statementOf(text, await service.tokenize(text), args.offset);
  const cte = args.cte === undefined ? undefined : statement?.ctes[args.cte];
  if (statement?.start !== args.offset || (args.cte !== undefined && cte?.name !== args.name)) {
    info('The statement changed since the lens was drawn. Use the lens again.');
    return undefined;
  }
  return cte
    ? { document, text: cte.sql, base: cte.start, readsOnly: true, cte: true }
    : {
        document,
        text: text.slice(statement.start, statement.end),
        base: statement.start,
        readsOnly: statement.readsOnly,
        cte: false,
      };
}

/** From a menu: the selection when it holds one statement, else the statement at the cursor. */
async function menuTarget(service: LanguageService): Promise<Target | undefined> {
  const editor = activeSqlEditor();
  if (!editor) return undefined;
  const { document, selection } = editor;
  const selected = document.getText(selection);
  if (selected.trim() !== '') {
    const tokens = await service.tokenize(selected);
    const statement = statementSpans(tokens).length === 1 ? statementOf(selected, tokens, 0) : undefined;
    if (!statement) {
      info('Select one statement, or put the cursor into it without a selection.');
      return undefined;
    }
    return {
      document,
      text: selected.slice(statement.start, statement.end),
      base: document.offsetAt(selection.start) + statement.start,
      readsOnly: statement.readsOnly,
      cte: false,
    };
  }
  const text = document.getText();
  const statement = statementOf(text, await service.tokenize(text), document.offsetAt(selection.active));
  if (!statement) {
    info('There is no statement at the cursor.');
    return undefined;
  }
  return {
    document,
    text: text.slice(statement.start, statement.end),
    base: statement.start,
    readsOnly: statement.readsOnly,
    cte: false,
  };
}

/** The CodeLens above queries and their CTEs, and the commands Execute, Explain, Analysis and Statistics. */
export function registerLenses(env: LensEnv): vscode.Disposable[] {
  const { editors, service, logger, editorOf, connectionOf } = env;
  const changed = new vscode.EventEmitter<void>();
  const failed = failureLog(logger);

  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changed.event,
    async provideCodeLenses(document, token) {
      // Only an editor of aantje gets lenses: another SQL file in the workspace is none of its business.
      if (!lensesOn() || connectionOf(document) === undefined) return [];
      const text = document.getText();
      // Without DuckDB's tokens (no engine, a closed service) there are no lenses; the failure is logged once.
      const tokens = await withFallback(failed, 'CodeLens', service.tokenize(text), undefined);
      if (!tokens || token.isCancellationRequested) return [];
      return lensesOf(document, text, tokens, cteRowLimit());
    },
  };

  const run = async (action: LensAction, target: Target, limit?: number): Promise<void> => {
    if (action === 'analyze' && !target.readsOnly) {
      const explain = 'Explain';
      const choice = await vscode.window.showWarningMessage(
        'Analysis runs the statement (EXPLAIN ANALYZE), and this one does more than read, or aantje cannot tell that it only reads. Explain shows the plan without running it.',
        explain,
      );
      if (choice === explain) await run('explain', target, limit);
      return;
    }
    const script: RunScript = {
      text: actionSql(action, target.text, limit),
      // EXPLAIN in front: positions of an error still lead into the statement.
      base: target.base - actionPrefix(action).length,
      ...(target.cte ? { built: true } : {}),
      // Execute goes into the Query History; Explain, Analysis and Statistics, which show a plan or a profile, do not.
      ...(action === 'execute' ? { record: true } : {}),
    };
    await editors.run(editorOf(target.document), script, action === 'profile' ? profiler() : undefined);
  };

  const command = (id: string, handler: (arg: unknown) => Promise<void>): vscode.Disposable =>
    registerGuarded(logger, id, handler);

  // From a lens: that statement or CTE. Without one (menu, palette, key): the selection or the statement at the cursor.
  const act = (action: LensAction) => async (arg: unknown) => {
    const target = isLensArgs(arg) ? await lensTarget(service, arg) : await menuTarget(service);
    // Only Execute of a CTE has a row limit.
    if (target) await run(action, target, action === 'execute' && target.cte ? cteRowLimit() : undefined);
  };

  return [
    changed,
    vscode.languages.registerCodeLensProvider(SQL_SELECTOR, provider),
    editors.onDidChange(({ association }) => {
      if (association) changed.fire();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('aantje.sql.codeLens') ||
        event.affectsConfiguration('aantje.sql.cteRowLimit')
      ) {
        changed.fire();
      }
    }),

    command(COMMANDS.execute, act('execute')),
    command(COMMANDS.explain, act('explain')),
    command(COMMANDS.analyze, act('analyze')),
    command(COMMANDS.profile, act('profile')),

    command('aantje.runCteWithLimit', async () => {
      const editor = activeSqlEditor();
      if (!editor) return;
      const { document, selection } = editor;
      const text = document.getText();
      const offset = document.offsetAt(selection.active);
      const statement = statementOf(text, await service.tokenize(text), offset);
      const cte = statement?.ctes.find(({ start, end }) => start <= offset && offset <= end);
      if (!cte) {
        info(
          'Put the cursor into a CTE of the outermost WITH. A CTE that does more than read is not offered.',
        );
        return;
      }
      const actions = (['execute', 'explain', 'analyze', 'profile'] as const).map((action) => ({
        label: LABELS[action],
        action,
      }));
      const picked = await vscode.window.showQuickPick(actions, {
        title: `Run the CTE ${cte.name} with a row limit`,
      });
      if (!picked) return;
      const answer = await vscode.window.showInputBox({
        title: `Row limit for the CTE ${cte.name}`,
        prompt: '1 for a single row, empty for all rows',
        value: String(cteRowLimit()),
        validateInput: (value) =>
          value.trim() === '' || /^[1-9]\d*$/.test(value.trim())
            ? undefined
            : 'A whole number of 1 or more, or empty',
      });
      if (answer === undefined) return;
      const limit = answer.trim() === '' ? undefined : Number(answer.trim());
      await run(
        picked.action,
        { document, text: cte.sql, base: cte.start, readsOnly: true, cte: true },
        limit,
      );
    }),
  ];
}
