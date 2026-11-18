import * as vscode from 'vscode';
import { fileNameOf } from './files';
import { normalizedText, utf8Bytes } from './model';
import type { TemplateStore } from './store';

/** The scheme of the editors of templates: `aantje-template:/<id>/<name>.sql`. */
export const TEMPLATE_SCHEME = 'aantje-template';

const encoder = new TextEncoder();

/**
 * The text of an own or imported template in an editor of its own; saving it (Ctrl+S) keeps the text in the store. A
 * text that aantje refuses (no name, a secret, ...) is not saved: the save fails with the reason and the editor keeps
 * the change. A saved imported template is one of the user's own from then on, so that an import of a newer version
 * does not replace it.
 */
export class TemplateDocuments implements vscode.FileSystemProvider {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private readonly deleted = new Set<string>();
  // The editor URI of each template that was opened, to tell its editor that the template changed or was deleted.
  private readonly opened = new Map<string, vscode.Uri>();
  private readonly listening: { dispose(): void };

  constructor(
    private readonly store: TemplateStore,
    /** Why aantje refuses a text as a template, or undefined when it keeps it. */
    private readonly check: (text: string) => Promise<string | undefined>,
  ) {
    // An import may replace the text of an open template: its editor reads it again, or asks before a save over it.
    this.listening = store.onDidChange(() =>
      this.changes.fire(
        [...this.opened]
          .filter(([id]) => !this.deleted.has(id))
          .map(([, uri]) => ({ type: vscode.FileChangeType.Changed, uri })),
      ),
    );
  }

  /** Opens a kept template in an editor. */
  async open(id: string, name: string): Promise<void> {
    const uri =
      this.opened.get(id) ?? vscode.Uri.from({ scheme: TEMPLATE_SCHEME, path: `/${id}/${fileNameOf(name)}` });
    this.opened.set(id, uri);
    await vscode.window.showTextDocument(uri, { preview: false });
  }

  /** The template was deleted: its editor shows so and can no longer save it. */
  forget(id: string): void {
    this.deleted.add(id);
    const uri = this.opened.get(id);
    if (uri) this.changes.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  dispose(): void {
    this.listening.dispose();
    this.changes.dispose();
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const id = idOf(uri);
    if (id === undefined) return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    const { text, time } = this.read(id, uri);
    return { type: vscode.FileType.File, ctime: time, mtime: time, size: utf8Bytes(text) };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const id = idOf(uri);
    if (id === undefined) throw vscode.FileSystemError.FileIsADirectory(uri);
    return encoder.encode(this.read(id, uri).text);
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const id = idOf(uri);
    if (id === undefined) throw vscode.FileSystemError.NoPermissions(uri);
    if (this.deleted.has(id)) {
      throw new vscode.FileSystemError(
        'The template was deleted. To keep its text, save it as a .sql file with Save As and import that file.',
      );
    }
    const text = normalizedText(new TextDecoder().decode(content));
    const problem = (await this.check(text)) ?? (await this.store.save(id, 'mine', text));
    if (problem !== undefined) throw new vscode.FileSystemError(`The template was not saved: ${problem}`);
    this.opened.set(id, uri);
    this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  // The text of a kept template, and when it was saved last.
  private read(id: string, uri: vscode.Uri): { text: string; time: number } {
    const stored = this.deleted.has(id) ? undefined : this.store.get(id);
    if (stored) return { text: stored.text, time: stored.updated };
    throw vscode.FileSystemError.FileNotFound(uri);
  }
}

/** The id of the template of an editor URI (`/<id>/<name>.sql`); undefined for a folder. */
function idOf(uri: vscode.Uri): string | undefined {
  const parts = uri.path.split('/').filter((part) => part !== '');
  return parts.length === 2 ? parts[0] : undefined;
}
