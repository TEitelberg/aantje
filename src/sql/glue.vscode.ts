import * as vscode from 'vscode';
import type { EditorRef } from './editor';

// What the VS Code glue of the SQL features shares: which documents they serve and how a document is found again.

/** The documents that the SQL features serve: SQL in an untitled document or a file, no other scheme. */
export const SQL_SELECTOR: vscode.DocumentSelector = [
  { language: 'sql', scheme: 'untitled' },
  { language: 'sql', scheme: 'file' },
];

/** Whether `SQL_SELECTOR` matches the document. */
export const isSqlDocument = (document: vscode.TextDocument): boolean =>
  document.languageId === 'sql' && (document.uri.scheme === 'untitled' || document.uri.scheme === 'file');

/** The key of a document in the SQL editor and its results: stable for the document's life. */
export const documentKey = (document: vscode.TextDocument): string => document.uri.toString();

/** The open document of a key, if it is still open. */
export const documentOfKey = (key: string): vscode.TextDocument | undefined =>
  vscode.workspace.textDocuments.find((document) => documentKey(document) === key);

export const editorOf = (document: vscode.TextDocument): EditorRef => ({
  key: documentKey(document),
  name: document.uri.path.split('/').pop() ?? document.uri.path,
});

/** The active editor when it shows SQL; otherwise says to open one. */
export function activeSqlEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.languageId === 'sql') return editor;
  void vscode.window.showInformationMessage('Open a SQL editor first.');
  return undefined;
}
