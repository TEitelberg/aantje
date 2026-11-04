import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { onTeardown } from './support';

/** Stands for "accept the value that the input box is prefilled with". */
export const KEEP = Symbol('keep the prefilled value');

export type Answer =
  | { readonly kind: 'pick'; readonly label: string | undefined }
  | { readonly kind: 'input'; readonly text: string | typeof KEEP | undefined }
  | { readonly kind: 'confirm'; readonly accepted: boolean };

/** Chooses the row with this label in the next quick pick; undefined cancels it. */
export const pick = (label: string | undefined): Answer => ({ kind: 'pick', label });
/** Types this text into the next input box; undefined cancels it. */
export const input = (text: string | typeof KEEP | undefined): Answer => ({ kind: 'input', text });
/** Answers the next modal confirmation. */
export const confirm = (accepted: boolean): Answer => ({ kind: 'confirm', accepted });

export interface Row {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
}

export interface PickCall {
  readonly title: string | undefined;
  readonly placeholder: string | undefined;
  readonly rows: Row[];
  /** Labels of the rows that were active (highlighted) when the picker opened. */
  readonly active: string[];
}

export interface InputCall {
  readonly title: string | undefined;
  readonly prompt: string | undefined;
  readonly value: string | undefined;
  readonly password: boolean | undefined;
  readonly validate: (value: string) => unknown;
}

/** The visible text of a row; texts the row does not have are left out, so rows compare naturally. */
function rowOf({ label, description, detail }: vscode.QuickPickItem): Row {
  return {
    label,
    ...(description === undefined ? {} : { description }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * The person and the operating system around the extension host. It answers the prompts of the extension from
 * a script, records the messages that the extension shows, and takes the place of the clipboard (a test run
 * must not overwrite the clipboard of the machine, and a restricted session has none). Nothing of our own
 * code is replaced. A prompt that the script does not expect is answered like a cancel and reported by
 * `assertDone`, because the extension catches an exception that is thrown into its command.
 */
export class Desktop {
  /** Every quick pick: `showQuickPick` and `createQuickPick` alike. */
  readonly picks: PickCall[] = [];
  /** How each picker of `createQuickPick` filters when it is shown; `showQuickPick` is not recorded. */
  readonly pickerOptions: { matchOnDescription: boolean; matchOnDetail: boolean }[] = [];
  readonly inputs: InputCall[] = [];
  /** The texts of the modal confirmations. */
  readonly confirmations: string[] = [];
  /** The `detail` text of each modal confirmation (empty when it has none), in the order of `confirmations`. */
  readonly confirmationDetails: string[] = [];
  /** The buttons of each modal confirmation (besides Cancel), in the order of `confirmations`. */
  readonly confirmationActions: string[][] = [];
  readonly infos: string[] = [];
  /** The texts of the warnings that are not confirmations. */
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  /** The buttons of each error message (none for most), in the order of `errors`. */
  readonly errorActions: string[][] = [];
  private readonly errorChoices: (string | undefined)[] = [];
  /** The titles of the progress notifications; they are shown for real. */
  readonly progress: string[] = [];
  /** The short status bar messages. */
  readonly statusMessages: string[] = [];
  /** What was written to the clipboard. */
  readonly copied: string[] = [];
  private readonly unexpected: string[] = [];

  private constructor(private readonly script: Answer[]) {
    const window = vscode.window as unknown as Record<string, unknown>;
    const replace = (name: string, replacement: unknown): void => {
      const original = window[name];
      window[name] = replacement;
      onTeardown(() => {
        window[name] = original;
      });
    };
    replace('showQuickPick', (items: readonly vscode.QuickPickItem[], options?: vscode.QuickPickOptions) =>
      Promise.resolve(this.answerPick(options?.title, options?.placeHolder, items, [])),
    );
    replace('showInputBox', (options?: vscode.InputBoxOptions) =>
      Promise.resolve(this.answerInput(options ?? {})),
    );
    replace('createQuickPick', () => this.createPicker());
    replace('showInformationMessage', (message: string) => {
      this.infos.push(message);
      return Promise.resolve(undefined);
    });
    replace('showErrorMessage', (message: string, ...actions: string[]) => {
      this.errors.push(message);
      this.errorActions.push(actions);
      return Promise.resolve(this.errorChoices.shift());
    });
    replace('showWarningMessage', (message: string, ...rest: unknown[]) =>
      Promise.resolve(this.answerWarning(message, rest)),
    );
    replace('setStatusBarMessage', (message: string) => {
      this.statusMessages.push(message);
      return new vscode.Disposable(() => undefined);
    });
    const withProgress = vscode.window.withProgress.bind(vscode.window) as (
      options: vscode.ProgressOptions,
      task: unknown,
    ) => Thenable<unknown>;
    replace('withProgress', (options: vscode.ProgressOptions, task: unknown) => {
      this.progress.push(options.title ?? '');
      return withProgress(options, task);
    });

    const clipboard = Object.getOwnPropertyDescriptor(vscode.env, 'clipboard');
    Object.defineProperty(vscode.env, 'clipboard', {
      configurable: true,
      get: () => ({
        readText: () => Promise.resolve(this.copied.at(-1) ?? ''),
        writeText: (text: string) => {
          this.copied.push(text);
          return Promise.resolve();
        },
      }),
    });
    onTeardown(() => {
      if (clipboard) {
        Object.defineProperty(vscode.env, 'clipboard', clipboard);
      }
    });
  }

  /** Takes over the prompts, the messages and the clipboard; the first answer of the script belongs to the first prompt. */
  static install(...answers: Answer[]): Desktop {
    return new Desktop(answers);
  }

  /** The button that the next error message that has buttons gets pressed; none is pressed otherwise. */
  pressOnError(label: string): void {
    this.errorChoices.push(label);
  }

  /** Appends answers for the prompts that come next. */
  answer(...answers: Answer[]): void {
    this.script.push(...answers);
  }

  /** Runs a command and returns what it wrote to the clipboard. */
  async copiedBy(command: string, ...args: unknown[]): Promise<string[]> {
    const before = this.copied.length;
    await vscode.commands.executeCommand(command, ...args);
    return this.copied.slice(before);
  }

  /** Fails if the extension asked something the script did not expect, or the script has answers left over. */
  assertDone(): void {
    assert.deepEqual(this.unexpected, [], 'prompts that did not match the script');
    assert.deepEqual(this.script, [], 'scripted answers that no prompt asked for');
  }

  private next<K extends Answer['kind']>(kind: K, prompt: string): Extract<Answer, { kind: K }> | undefined {
    const answer = this.script.shift();
    if (answer?.kind === kind) {
      return answer as Extract<Answer, { kind: K }>;
    }
    this.unexpected.push(
      `${prompt} asked for a ${kind}, but the script has ${answer ? `a ${answer.kind}` : 'nothing'} next`,
    );
    return undefined;
  }

  private answerPick<T extends vscode.QuickPickItem>(
    title: string | undefined,
    placeholder: string | undefined,
    items: readonly T[],
    active: readonly T[],
  ): T | undefined {
    this.picks.push({
      title,
      placeholder,
      rows: items.map(rowOf),
      active: active.map((item) => item.label),
    });
    const answer = this.next('pick', `The quick pick "${title}"`);
    if (answer?.label === undefined) {
      return undefined;
    }
    const chosen = items.find((item) => item.label === answer.label);
    if (!chosen) {
      this.unexpected.push(`The quick pick "${title}" has no row "${answer.label}"`);
    }
    return chosen;
  }

  private answerInput(options: vscode.InputBoxOptions): string | undefined {
    const validate = (value: string): unknown => options.validateInput?.(value);
    this.inputs.push({
      title: options.title,
      prompt: options.prompt,
      value: options.value,
      password: options.password,
      validate,
    });
    const answer = this.next('input', `The input box "${options.title}"`);
    const text = answer?.text === KEEP ? options.value : answer?.text;
    // VS Code does not accept a value that the validation rejects.
    const rejection = text === undefined ? undefined : validate(text);
    if (rejection) {
      this.unexpected.push(
        `The input box "${options.title}" rejects "${text}": ${JSON.stringify(rejection)}`,
      );
      return undefined;
    }
    return text;
  }

  private answerWarning(message: string, rest: unknown[]): string | undefined {
    const [options, ...actions] = rest;
    if (!(typeof options === 'object' && options !== null && 'modal' in options && options.modal === true)) {
      this.warnings.push(message);
      return undefined;
    }
    this.confirmations.push(message);
    this.confirmationActions.push(actions.map(String));
    const { detail } = options as { detail?: string };
    this.confirmationDetails.push(detail ?? '');
    const accepted = this.next('confirm', `The confirmation "${message}"`)?.accepted;
    return accepted ? (actions[0] as string) : undefined;
  }

  /** The part of `vscode.QuickPick` that the extension uses, answered from the script once it is shown. */
  private createPicker(): vscode.QuickPick<vscode.QuickPickItem> {
    const accepted: (() => void)[] = [];
    const hidden: (() => void)[] = [];
    const picker = {
      title: undefined as string | undefined,
      placeholder: undefined as string | undefined,
      items: [] as readonly vscode.QuickPickItem[],
      activeItems: [] as readonly vscode.QuickPickItem[],
      selectedItems: [] as readonly vscode.QuickPickItem[],
      matchOnDescription: false,
      matchOnDetail: false,
      onDidAccept: (listener: () => void) => {
        accepted.push(listener);
        return new vscode.Disposable(() => undefined);
      },
      onDidHide: (listener: () => void) => {
        hidden.push(listener);
        return new vscode.Disposable(() => undefined);
      },
      show: () => {
        this.pickerOptions.push({
          matchOnDescription: picker.matchOnDescription,
          matchOnDetail: picker.matchOnDetail,
        });
        queueMicrotask(() => {
          const chosen = this.answerPick(picker.title, picker.placeholder, picker.items, picker.activeItems);
          if (chosen) {
            picker.selectedItems = [chosen];
            accepted.forEach((listener) => listener());
          } else {
            picker.hide();
          }
        });
      },
      hide: () => hidden.forEach((listener) => listener()),
      dispose: () => undefined,
    };
    return picker as unknown as vscode.QuickPick<vscode.QuickPickItem>;
  }
}
