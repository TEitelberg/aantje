import * as vscode from 'vscode';
import { documentAddress } from './compare';
import type { SchemaComparison, SchemaDocument } from './compare';

const SCHEME = 'aantje-schema';

// Each report gets an address of its own; the texts of the older ones are dropped, so that they do not pile up over a
// session. A diff document has the address of its table and snapshot, so comparing it again replaces its text.
const KEPT_REPORTS = 20;

/** The read-only schema diff documents and comparison reports: the texts that were computed, kept by address. */
export class SchemaDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly texts = new Map<string, string>();
  /** The addresses of the kept reports, oldest first. */
  private readonly kept: string[] = [];
  private reports = 0;
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? '';
  }

  async show({ title, documents }: Pick<SchemaComparison, 'title' | 'documents'>): Promise<void> {
    if (!documents) {
      return;
    }
    const [left, right] = [documents.left, documents.right].map((document) => this.publish(document));
    await vscode.commands.executeCommand('vscode.diff', left, right, title);
  }

  /**
   * Shows `markdown` in the Markdown preview, as a read-only document named `fileName`; without the preview (the
   * built-in Markdown extension is off) it opens the document itself.
   */
  async preview(fileName: string, markdown: string): Promise<vscode.Uri> {
    this.reports += 1;
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/reports/${this.reports}/${fileName}` });
    this.texts.set(uri.toString(), markdown);
    this.kept.push(uri.toString());
    for (const old of this.kept.splice(0, Math.max(0, this.kept.length - KEPT_REPORTS)))
      this.texts.delete(old);
    this.changed.fire(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    try {
      await vscode.commands.executeCommand('markdown.showPreview', uri);
    } catch {
      await vscode.window.showTextDocument(document);
    }
    return uri;
  }

  dispose(): void {
    this.registration.dispose();
    this.changed.dispose();
  }

  private publish({ key, text }: SchemaDocument): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: SCHEME, ...documentAddress(key) });
    this.texts.set(uri.toString(), text);
    this.changed.fire(uri);
    return uri;
  }
}
