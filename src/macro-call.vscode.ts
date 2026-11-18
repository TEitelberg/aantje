import * as vscode from 'vscode';
import type { Register } from './command.vscode';
import { macroCall, macroCallScript, overloadText, parameterHint } from './macro-call';
import { pickerLabel } from './messages';
import { pickOne } from './pick.vscode';
import type { CatalogTree } from './tree/model';

interface MacroCallEnv {
  readonly tree: CatalogTree;
  readonly register: Register;
  /** Opens the text in a new SQL editor bound to the connection; it never runs it. */
  readonly openSql: (connectionId: string, text: string) => Promise<void>;
}

/**
 * Execute Macro on a macro: the overload (when there are several), then one input per parameter in order; the call
 * opens in a SQL document of the connection. It runs nothing: a table macro can call a function that changes the lake.
 */
export function registerMacroCallCommand({ tree, register, openSql }: MacroCallEnv): vscode.Disposable {
  return register('aantje.executeMacro', async (node) => {
    if (node?.ref.kind !== 'macro') return;
    const { schema, macro, connectionId } = node.ref;
    const title = `Execute Macro ${node.label}`;
    const overloads = macro.implementations.map((implementation, index) => ({
      label: pickerLabel(overloadText(implementation.parameters)),
      index,
    }));
    const picked =
      overloads.length > 1
        ? await pickOne(overloads, { title, placeholder: 'Pick the overload to call' })
        : overloads[0];
    const parameters = picked && macro.implementations[picked.index]?.parameters;
    if (!parameters) return;
    const values: (string | undefined)[] = [];
    for (const [index, parameter] of parameters.entries()) {
      const value = await vscode.window.showInputBox({
        title: `${title} (${index + 1}/${parameters.length})`,
        prompt: `${pickerLabel(parameter.name)}: ${parameterHint(parameter)}`,
        ignoreFocusOut: true,
        validateInput: (text) =>
          parameter.defaultValue === null && text.trim() === '' ? 'A value is needed.' : undefined,
      });
      if (value === undefined) return;
      values.push(value);
    }
    await openSql(
      connectionId,
      macroCallScript(tree, connectionId, macroCall(schema.name, macro, parameters, values)),
    );
  });
}
