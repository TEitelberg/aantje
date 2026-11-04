import * as vscode from 'vscode';
import type { CatalogTree } from './model';
import type { TreeNode } from './refs';

// Create Notebook cannot sign in to an Azure DuckLake: its tables and views get `.azure` on their context value, so
// the menus offer everything else there and leave Create Notebook out.
const MARKED_ON_AZURE = new Set(['table', 'view']);

/** Maps the tree model to VS Code tree items; the model makes all decisions. */
export class CatalogTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  private readonly subscription: { dispose(): void };

  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly tree: CatalogTree,
    private readonly onAzureLake: (connectionId: string) => boolean = () => false,
  ) {
    this.subscription = tree.onDidChange((node) => this.changed.fire(node));
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.tooltip === undefined ? undefined : new vscode.MarkdownString(node.tooltip);
    item.iconPath = new vscode.ThemeIcon(
      node.icon,
      node.iconColor === undefined ? undefined : new vscode.ThemeColor(node.iconColor),
    );
    item.contextValue =
      MARKED_ON_AZURE.has(node.contextValue) && this.onAzureLake(node.ref.connectionId)
        ? `${node.contextValue}.azure`
        : node.contextValue;
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
    this.subscription.dispose();
    this.changed.dispose();
  }
}
