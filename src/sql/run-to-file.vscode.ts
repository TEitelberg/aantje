import * as vscode from 'vscode';
import { registerGuarded } from '../command.vscode';
import { chooseExportTarget } from '../export/save.vscode';
import type { Logger } from '../log';
import type { EditorRef, QueryEditors } from './editor';
import type { LanguageService } from './language';
import { menuTarget } from './lens.vscode';
import { fileRunRefusal, runToFile } from './run-to-file';

interface RunToFileEnv {
  readonly editors: QueryEditors;
  readonly service: LanguageService;
  readonly logger: Logger;
  readonly editorOf: (document: vscode.TextDocument) => EditorRef;
}

/**
 * Run to File...: the statement at the cursor (or the selection, when it is one statement) written to a CSV or Parquet
 * file in the session of its editor, without the row limit of the grid (`run-to-file.ts`).
 */
export function registerRunToFile({ editors, service, logger, editorOf }: RunToFileEnv): vscode.Disposable {
  return registerGuarded(logger, 'aantje.runToFile', async () => {
    const statement = await menuTarget(service);
    if (!statement) return;
    const refused = fileRunRefusal(statement);
    if (refused) {
      void vscode.window.showWarningMessage(refused);
      return;
    }
    const target = await chooseExportTarget('Run to File', 'result');
    if (target) await runToFile(editors, editorOf(statement.document), statement, target);
  });
}
