import * as vscode from 'vscode';
import { documentAddress } from './compare';
import type { SchemaComparison, SchemaDocument } from './compare';

const SCHEME = 'aantje-schema';

/** The read-only schema diff documents: the text `compareSchema` computed, kept by address. */
export class SchemaDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly texts = new Map<string, string>();
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
