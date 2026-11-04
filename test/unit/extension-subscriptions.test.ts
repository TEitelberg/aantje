import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { activate as Activate } from '../../src/extension';

interface Registration {
  /** The call that made it, e.g. `vscode.window.createTreeView`, and the id of a command. */
  readonly name: string;
  disposed: boolean;
}

// The whole editor API as one stand-in: every member is a stand-in again, and so is the result of every call. A
// call of `create*`, `register*` or `on*` is a registration, and the stand-in it returns notes its `dispose()`.
// `get` answers with the default, as an unset setting or an empty memento does.
const editor = vi.hoisted(() => {
  const registrations: Registration[] = [];
  const records = new WeakMap<object, Registration>();
  const REGISTRATION = /\.(create|register|on)[A-Z]\w*$/;

  function stub(name: string): object {
    const members = new Map<string | symbol, unknown>();
    const proxy: object = new Proxy(function () {}, {
      has: () => true,
      get(_target, key) {
        if (key === 'then') {
          return undefined;
        }
        if (key === Symbol.toPrimitive) {
          return () => name;
        }
        if (key === 'dispose') {
          return () => {
            const record = records.get(proxy);
            if (record) {
              record.disposed = true;
            }
          };
        }
        if (!members.has(key)) {
          members.set(key, stub(`${name}.${String(key)}`));
        }
        return members.get(key);
      },
      set(_target, key, value: unknown) {
        members.set(key, value);
        return true;
      },
      apply(_target, _this, args: unknown[]) {
        if (name === 'vscode.Disposable.from') {
          return { dispose: () => args.forEach((part) => (part as { dispose(): void }).dispose()) };
        }
        if (name.endsWith('.get')) {
          return args[1];
        }
        const result = stub(`${name}()`);
        if (REGISTRATION.test(name)) {
          const record = { name: typeof args[0] === 'string' ? `${name} ${args[0]}` : name, disposed: false };
          registrations.push(record);
          records.set(result, record);
        }
        return result;
      },
      construct(_target, args: unknown[]) {
        return name === 'vscode.Disposable' ? { dispose: args[0] as () => void } : stub(`new ${name}`);
      },
    });
    return proxy;
  }

  return { stub, registrations };
});

// The module itself must be an object; its members come from the stand-in behind it.
vi.mock('vscode', () => Object.create(editor.stub('vscode')) as object);

it('keeps every registration of the activation in the subscriptions, so disposing them leaves nothing behind', async () => {
  const { activate, deactivate } = await import('../../src/extension');
  const { ViewTrustStore } = await import('../../src/data/trust');
  const { QueryEditors } = await import('../../src/sql/editor');
  const { CatalogTree } = await import('../../src/tree/model');
  // aantje's own events that the activation listens to: a listener that is never removed outlives the extension too.
  const listens = {
    'CatalogTree.onDidChange': vi.spyOn(CatalogTree.prototype, 'onDidChange'),
    'QueryEditors.onDidChange': vi.spyOn(QueryEditors.prototype, 'onDidChange'),
    'ViewTrustStore.onDidTrust': vi.spyOn(ViewTrustStore.prototype, 'onDidTrust'),
  };
  const context = {
    subscriptions: [] as { dispose(): unknown }[],
    extensionPath: 'unused',
    extensionUri: editor.stub('context.extensionUri'),
    extensionMode: 1,
    secrets: editor.stub('context.secrets'),
    globalState: editor.stub('context.globalState'),
  };

  activate(context as unknown as Parameters<typeof Activate>[0]);

  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    contributes: { commands: { command: string }[] };
  };
  const names = editor.registrations.map(({ name }) => name);
  expect(names.filter((name) => name.startsWith('vscode.commands.registerCommand ')).sort()).toEqual(
    manifest.contributes.commands.map(({ command }) => `vscode.commands.registerCommand ${command}`).sort(),
  );
  expect(names).toEqual(
    expect.arrayContaining([
      'vscode.window.createOutputChannel aantje',
      'vscode.window.createTreeView aantje.catalogs',
      'vscode.window.createStatusBarItem aantje.status',
      'vscode.window.createStatusBarItem aantje.queryStatus',
      'vscode.workspace.onDidChangeConfiguration',
    ]),
  );
  const own = Object.entries(listens).flatMap(([name, spy]) =>
    spy.mock.results.map(({ value }) => ({
      name,
      dispose: vi.spyOn(value as { dispose(): void }, 'dispose'),
    })),
  );
  expect(new Set(own.map(({ name }) => name))).toEqual(new Set(Object.keys(listens)));

  // What VS Code does when the extension is deactivated.
  await deactivate();
  for (const subscription of context.subscriptions) {
    subscription.dispose();
  }

  expect(editor.registrations.filter(({ disposed }) => !disposed).map(({ name }) => name)).toEqual([]);
  expect(own.filter(({ dispose }) => dispose.mock.calls.length === 0).map(({ name }) => name)).toEqual([]);
});
