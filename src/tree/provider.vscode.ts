import * as vscode from 'vscode';
import type { CatalogTree } from './model';
import type { TreeNode } from './refs';

/**
 * The variant of a logo for the colour of its row: the logo of `media/` is drawn in the colour of the theme's
 * `charts.green` or `charts.red`, or neutral while it has none (`media/<logo>-<variant>-<light|dark>.svg`). A file has
 * one colour; a theme colour cannot reach it, so each variant has the default colours of the light and dark themes.
 */
const LOGO_VARIANTS: Readonly<Record<string, string>> = { 'charts.green': 'green', 'charts.red': 'red' };

/** Maps the tree model to VS Code tree items; the model makes all decisions. */
export class CatalogTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  private readonly subscriptions: { dispose(): void }[];

  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly tree: CatalogTree,
    /** Tells when the Query History of a connection changed: only its folder is read again, not the catalog. */
    onDidChangeHistory?: (listener: (connectionId: string | undefined) => void) => { dispose(): void },
    /** The folder of the extension, for the logos of `media/`; without it a row shows its codicon. */
    private readonly extensionUri?: vscode.Uri,
  ) {
    this.subscriptions = [
      tree.onDidChange((node) => this.changed.fire(node)),
      ...(onDidChangeHistory
        ? [
            onDidChangeHistory((connectionId) => {
              const folder = connectionId === undefined ? undefined : tree.queryHistoryFolder(connectionId);
              if (folder) this.changed.fire(folder);
            }),
          ]
        : []),
    ];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.tooltip === undefined ? undefined : new vscode.MarkdownString(node.tooltip);
    const base = this.extensionUri;
    if (node.logo !== undefined && base !== undefined) {
      const variant = (node.iconColor === undefined ? undefined : LOGO_VARIANTS[node.iconColor]) ?? 'plain';
      const file = (theme: string): vscode.Uri =>
        vscode.Uri.joinPath(base, 'media', `${node.logo}-${variant}-${theme}.svg`);
      item.iconPath = { light: file('light'), dark: file('dark') };
    } else {
      item.iconPath = new vscode.ThemeIcon(
        node.icon,
        node.iconColor === undefined ? undefined : new vscode.ThemeColor(node.iconColor),
      );
    }
    item.contextValue = node.contextValue;
    if (node.command) {
      item.command = { command: node.command.id, title: node.command.title, arguments: [node] };
    }
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] | Thenable<TreeNode[]> {
    return node ? this.tree.children(node) : this.tree.roots();
  }

  getParent(node: TreeNode): TreeNode | undefined {
    return this.tree.parent(node);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}
