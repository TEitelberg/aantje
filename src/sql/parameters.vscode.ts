import * as vscode from 'vscode';
import { namesSecret } from './history-mask';
import { valueProblem } from './parameters';
import type { ScriptParameter } from './parameters';

/**
 * The dialog of the parameters (`parameters.ts`), for the SQL editor and the templates: one input box per parameter in
 * a row of steps, with its name, type, description, and the initial value (the last value, else the default). The value
 * is checked against its type while typing; Enter goes to the next parameter and ends with the last one, Back returns
 * to the one before, Escape cancels. A parameter named like a secret is typed hidden. Resolves to the values by name,
 * or undefined when cancelled; with no parameter it resolves at once to none.
 */
export async function askParameterValues(
  parameters: readonly ScriptParameter[],
  initial: Readonly<Record<string, string>>,
  title: string,
): Promise<Record<string, string> | undefined> {
  const values: Record<string, string> = { ...initial };
  let step = 0;
  while (step < parameters.length) {
    const parameter = parameters[step];
    if (!parameter) break;
    const answer = await askOne(parameter, values[parameter.name] ?? '', {
      title,
      step: step + 1,
      total: parameters.length,
    });
    if (answer === undefined) return undefined;
    if (answer === BACK) {
      step--;
      continue;
    }
    values[parameter.name] = answer;
    step++;
  }
  return Object.fromEntries(parameters.map(({ name }) => [name, values[name] ?? '']));
}

const BACK = Symbol('back');

function askOne(
  parameter: ScriptParameter,
  value: string,
  where: { title: string; step: number; total: number },
): Promise<string | typeof BACK | undefined> {
  return new Promise((resolve) => {
    const box = vscode.window.createInputBox();
    box.title = where.title;
    box.step = where.step;
    box.totalSteps = where.total;
    box.value = value;
    box.ignoreFocusOut = true;
    box.password = namesSecret(parameter.name);
    box.placeholder = parameter.defaultValue === undefined ? undefined : `Default: ${parameter.defaultValue}`;
    box.prompt = promptOf(parameter);
    box.buttons = where.step > 1 ? [vscode.QuickInputButtons.Back] : [];
    const check = (text: string): void => {
      const problem = valueProblem(parameter.type, text);
      box.validationMessage = problem === undefined ? undefined : `Give ${problem}.`;
    };
    check(value);
    let answer: string | typeof BACK | undefined;
    box.onDidChangeValue(check);
    box.onDidTriggerButton(() => {
      answer = BACK;
      box.hide();
    });
    box.onDidAccept(() => {
      if (valueProblem(parameter.type, box.value) !== undefined) return;
      answer = box.value;
      box.hide();
    });
    box.onDidHide(() => {
      box.dispose();
      resolve(answer);
    });
    box.show();
  });
}

function promptOf(parameter: ScriptParameter): string {
  const usage = parameter.kinds.map((kind) =>
    kind === 'value' ? `$${parameter.name}` : `{{${parameter.name}}}`,
  );
  const head = `${usage.join(' and ')} (${parameter.type})`;
  return parameter.description ? `${head}: ${parameter.description}` : head;
}
