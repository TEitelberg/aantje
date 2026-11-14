import * as vscode from 'vscode';
import type { Logger } from '../log';
import { failureLog, withFallback } from '../log-once';
import { formatSql, keywordCaseOf, sameTokens } from './format';
import { SQL_SELECTOR } from './glue.vscode';
import type { LanguageService } from './language';

interface FormatEnv {
  readonly service: LanguageService;
  readonly logger: Logger;
  readonly connectionOf: (document: vscode.TextDocument) => string | undefined;
}

/** Format Document and Format Selection for the SQL editors of aantje (those with a connection). */
export function registerSqlFormatting(env: FormatEnv): vscode.Disposable[] {
  const { service, logger, connectionOf } = env;
  const failed = failureLog(logger);
  const refuse = (reason: string): undefined => {
    void vscode.window.showWarningMessage(`aantje could not format the SQL: ${reason}`);
    return undefined;
  };

  /** The text formatted, or undefined (and a message) when it cannot be, or would not mean the same any more. */
  const formatted = async (text: string, options: vscode.FormattingOptions): Promise<string | undefined> => {
    const result = formatSql(text, {
      tabWidth: options.tabSize,
      useTabs: !options.insertSpaces,
      keywordCase: keywordCaseOf(
        vscode.workspace.getConfiguration('aantje').get<unknown>('sql.formatKeywordCase'),
      ),
    });
    if ('error' in result) return refuse(result.error);
    // A formatter must never change what the SQL means: DuckDB's tokens decide; without them nothing is formatted.
    const tokens = await withFallback(
      failed,
      'Formatting',
      Promise.all([service.tokenize(text), service.tokenize(result.text)]),
      undefined,
    );
    if (!tokens) return refuse('DuckDB could not check the formatted text. See the aantje log.');
    if (!sameTokens(...tokens)) {
      logger.info('Formatting was refused: the formatted SQL had other tokens than the original.');
      void vscode.window.showWarningMessage(
        'aantje left the SQL as it was: formatted, it would differ in more than blanks and the case of keywords.',
      );
      return undefined;
    }
    return result.text;
  };

  const provider: vscode.DocumentFormattingEditProvider & vscode.DocumentRangeFormattingEditProvider = {
    async provideDocumentFormattingEdits(document, options) {
      // Another SQL file of the workspace is left to other extensions.
      if (connectionOf(document) === undefined) return [];
      const text = document.getText();
      if (text.trim() === '') return [];
      const result = await formatted(text, options);
      if (result === undefined) return [];
      // Keep the document's last line break, as the formatter drops it.
      const next = /\r?\n$/.test(text) ? `${result}\n` : result;
      return next === text
        ? []
        : [vscode.TextEdit.replace(new vscode.Range(0, 0, document.lineCount, 0), next)];
    },

    async provideDocumentRangeFormattingEdits(document, range, options) {
      if (connectionOf(document) === undefined) return [];
      // Whole lines, so that the selection is indented like its first line.
      const lines = new vscode.Range(
        range.start.line,
        0,
        range.end.line,
        document.lineAt(range.end.line).text.length,
      );
      const text = document.getText(lines);
      if (text.trim() === '') return [];
      const result = await formatted(text, options);
      if (result === undefined) return [];
      const indent = /^\s*/.exec(document.lineAt(range.start.line).text)?.[0] ?? '';
      const next = result
        .split('\n')
        .map((line) => (line === '' ? line : `${indent}${line}`))
        .join('\n');
      return next === text ? [] : [vscode.TextEdit.replace(lines, next)];
    },
  };

  return [
    vscode.languages.registerDocumentFormattingEditProvider(SQL_SELECTOR, provider),
    vscode.languages.registerDocumentRangeFormattingEditProvider(SQL_SELECTOR, provider),
  ];
}
