import type { CatalogEntry } from './catalog/model';
import { withoutIcons } from './messages';
import { collator } from './order';
import { connectionNodeId, folderId, schemaNodeId, tableNodeId, viewNodeId } from './tree/nodes';

interface SearchPickItem {
  readonly label: string;
  readonly description: CatalogEntry['kind'];
  readonly value: CatalogEntry;
}

/** Rows for the "Search Catalog" picker, by schema then name in tree order; VS Code filters. */
export function searchPickItems(entries: readonly CatalogEntry[]): SearchPickItem[] {
  return entries
    .toSorted((a, b) => collator.compare(a.schemaName, b.schemaName) || collator.compare(a.name, b.name))
    .map((entry) => ({
      label: withoutIcons(`${entry.schemaName}.${entry.name}`),
      description: entry.kind,
      value: entry,
    }));
}

/** Id of `entry`'s tree node below the Tables or Views folder (built in `tree/nodes.ts`). */
export function treeNodeId(connectionId: string, entry: CatalogEntry): string {
  const folder = folderNodeId(connectionId, entry);
  return entry.kind === 'table' ? tableNodeId(folder, entry.id) : viewNodeId(folder, entry.id);
}

/** Id of the Tables or Views folder holding `entry`'s node. */
export function folderNodeId(connectionId: string, entry: CatalogEntry): string {
  const schema = schemaNodeId(connectionNodeId(connectionId), entry.schemaId);
  return folderId(schema, entry.kind === 'table' ? 'tables' : 'views');
}
