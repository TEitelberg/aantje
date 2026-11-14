import * as vscode from 'vscode';
import { catalogAt } from '../actions';
import type { Register } from '../command.vscode';
import { scriptGraph } from '../dependencies/order';
import type { SqlParser, SqlTokenizer } from '../dependencies/parser';
import { readObjects } from '../dependencies/read';
import type { Logger } from '../log';
import { pickMany, pickOne } from '../pick.vscode';
import { cancellable } from '../progress.vscode';
import type { CatalogTree } from '../tree/model';
import type { NodeRef } from '../tree/refs';
import { lakeObjects, objectItems, OUTPUTS } from './objects';
import { readScriptInput } from './read';
import { generateScript, scriptFiles } from './script';
import { folderPort, writeFiles } from './write';
import type { FolderPort, WriteOutcome } from './write';

interface GenerateScriptsEnv {
  readonly tree: Pick<CatalogTree, 'state' | 'reader'>;
  /** Opens the text in a new SQL document bound to the connection, and runs nothing. */
  readonly openSql: (connectionId: string, text: string) => Promise<void>;
  readonly logger: Logger;
  readonly register: Register;
  /** Parses views and macros for their order and tokenizes the statements that copy catalog text; it runs nothing. */
  readonly parser: SqlParser & SqlTokenizer;
}

const COMMAND = 'aantje.generateScripts';
const TITLE = 'Generate Scripts';
// The unmatched files that the closing message names; it counts the others.
const SHOWN = 10;

/** The chosen folder through the VS Code file system; `folderPort` keeps every path below it. */
function chosenFolder(folder: vscode.Uri): FolderPort {
  const { fs } = vscode.workspace;
  const at = (path: string): vscode.Uri => folder.with({ path });
  return folderPort(folder.path, {
    stat: (path) => fs.stat(at(path)),
    readDirectory: (path) => fs.readDirectory(at(path)),
    createDirectory: (path) => fs.createDirectory(at(path)),
    writeFile: (path, content) => fs.writeFile(at(path), content),
    notFound: (error) => error instanceof vscode.FileSystemError && error.code === 'FileNotFound',
  });
}

async function chooseFolder(): Promise<vscode.Uri | undefined> {
  const chosen = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: 'Generate Scripts: the folder for the files',
    openLabel: 'Write Here',
  });
  return chosen?.[0];
}

/** One question for all files that exist. */
async function overwrite(existing: number, total: number): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    `${existing} of the ${total} files exist in the folder. Overwrite them?`,
    { modal: true, detail: 'Files that no selected object matches stay as they are.' },
    'Overwrite',
  );
  return answer === 'Overwrite';
}

function report(folder: vscode.Uri, outcome: WriteOutcome): void {
  if (outcome.kind === 'declined') {
    void vscode.window.showInformationMessage('Nothing was written.');
    return;
  }
  if (outcome.kind === 'refused') {
    void vscode.window.showErrorMessage(
      outcome.reason === 'link'
        ? `Generate Scripts stopped at ${outcome.path}: it is a symbolic link below the folder, and aantje writes no file through one.`
        : `Generate Scripts stopped at ${outcome.path}: it is not the kind of entry the script writes there (a file instead of a folder, or the other way round).`,
    );
    return;
  }
  const { files, unmatched } = outcome;
  const more = unmatched.length > SHOWN ? ` and ${unmatched.length - SHOWN} more` : '';
  void vscode.window.showInformationMessage(
    [
      `Wrote ${files} files to ${folder.fsPath}.`,
      ...(unmatched.length === 0
        ? []
        : [
            `These .sql files below the schema folders match no selected object: ${unmatched.slice(0, SHOWN).join(', ')}${more}.`,
          ]),
    ].join(' '),
  );
}

async function run(env: GenerateScriptsEnv, ref: NodeRef | undefined): Promise<void> {
  const { parser, logger } = env;
  if (ref?.kind !== 'connection' && ref?.kind !== 'schema') return;
  const { connectionId } = ref;
  const { reader, snapshot } = catalogAt(env.tree, connectionId, 'generate scripts');
  const lake = await cancellable('Reading the catalog...', (signal) => readObjects(reader, snapshot, signal));
  const objects = lakeObjects(lake, ref.kind === 'schema' ? ref.schema.id : undefined);
  if (objects.length === 0) {
    void vscode.window.showInformationMessage(
      `The ${ref.kind === 'schema' ? 'schema' : 'catalog'} has no tables, views or macros at snapshot ${snapshot}.`,
    );
    return;
  }
  const picked = await pickMany(objectItems(objects), {
    title: TITLE,
    placeholder: 'The tables, views and macros to script',
  });
  if (!picked || picked.length === 0) return;
  const output = await pickOne(OUTPUTS, { title: TITLE, placeholder: 'Where the script goes' });
  if (!output) return;
  const folder = output.value === 'files' ? await chooseFolder() : undefined;
  if (output.value === 'files' && !folder) return;
  const script = await cancellable('Writing the script...', async (signal) => {
    const input = await readScriptInput(
      reader,
      snapshot,
      lake,
      picked.map(({ value }) => value),
      // The graph of the whole lake orders the views and macros; without it they keep their place.
      (all) =>
        scriptGraph(all, parser, {
          signal,
          logger,
          failure: 'Reading which views and macros use which failed; the script leaves their order as it is.',
        }),
      signal,
    );
    return generateScript(input, (text) => parser.tokenize(text));
  });
  if (!folder) {
    await env.openSql(connectionId, script.text);
    return;
  }
  report(folder, await writeFiles(chosenFolder(folder), scriptFiles(script), overwrite));
}

/** Generate Scripts: the DDL of the tables, views and macros of a connection or a schema, as a document or as files. */
export function registerGenerateScripts(env: GenerateScriptsEnv): vscode.Disposable[] {
  return [env.register(COMMAND, (node) => run(env, node?.ref))];
}
