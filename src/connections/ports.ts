// Ports to the editor: logic depends on these interfaces; `ports.vscode.ts` implements them.

/** The raw `aantje.connections` setting (profiles without passwords). */
export interface SettingsPort {
  read(): unknown;
  write(value: unknown): Promise<void>;
}

export interface SecretsPort {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PickItem<T extends string> {
  readonly label: string;
  readonly description?: string;
  readonly value: T;
}

export interface InputOptions {
  readonly title: string;
  readonly prompt: string;
  readonly value?: string;
  readonly password?: boolean;
  /** An error message, or undefined when the value is valid. */
  readonly validate?: (value: string) => string | undefined;
}

/** User interaction of the connection wizard; a cancelled prompt resolves to `undefined`. */
export interface WizardUi {
  pick<T extends string>(title: string, items: readonly PickItem<T>[]): Promise<T | undefined>;
  input(options: InputOptions): Promise<string | undefined>;
  confirm(message: string, action: string): Promise<boolean>;
  info(message: string): void;
  error(message: string): void;
  /** `report` changes the line under the title while the task runs. */
  withProgress<T>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T>;
}
