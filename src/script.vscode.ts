import * as vscode from 'vscode';

/** Opens the text in a new untitled SQL document; `beforeShow` runs before an editor shows it, so its connection is set. */
export async function openScript(
  text: string,
  beforeShow: (document: vscode.TextDocument) => Promise<void>,
): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument({ language: 'sql', content: text });
  await beforeShow(document);
  await vscode.window.showTextDocument(document);
  return document;
}
