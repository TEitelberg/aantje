import type { CatalogColumnEntry, CatalogEntry } from './catalog/model';
import { pickerLabel } from './messages';
import { collator } from './order';
import {
  columnNodeId,
  connectionNodeId,
  folderId,
  schemaNodeId,
  tableNodeId,
  viewNodeId,
} from './tree/nodes';

/** A column or nested field with the table that holds it. */
export interface ColumnHit {
  readonly kind: 'column';
  readonly table: CatalogEntry;
  readonly column: CatalogColumnEntry;
}

/** What a row of the search stands for. */
export type SearchHit = CatalogEntry | ColumnHit;

interface SearchPickItem {
  readonly label: string;
  readonly description: string;
  readonly value: SearchHit;
}

/**
 * Rows for the "Search Catalog" picker: tables and views by schema then name in tree order, each table followed by
 * its columns (`columns` by table id) in the order of the tree; VS Code filters.
 */
export function searchPickItems(
  entries: readonly CatalogEntry[],
  columns: ReadonlyMap<number, readonly CatalogColumnEntry[]>,
): SearchPickItem[] {
  return entries
    .toSorted((a, b) => collator.compare(a.schemaName, b.schemaName) || collator.compare(a.name, b.name))
    .flatMap((entry) => {
      const name = `${entry.schemaName}.${entry.name}`;
      const fields = entry.kind === 'table' ? (columns.get(entry.id) ?? []) : [];
      return [
        { label: pickerLabel(name), description: entry.kind, value: entry },
        ...fields.map((column) => ({
          label: pickerLabel([name, ...column.path].join('.')),
          description: pickerLabel(`column · ${column.type}`),
          value: { kind: 'column' as const, table: entry, column },
        })),
      ];
    });
}

/** Ids of the nodes from the schema down to the hit's node, each a child of the one before (built in `tree/nodes.ts`). */
export function treeNodePath(connectionId: string, hit: SearchHit): string[] {
  const entry = hit.kind === 'column' ? hit.table : hit;
  const schema = schemaNodeId(connectionNodeId(connectionId), entry.schemaId);
  const folder = folderId(schema, entry.kind === 'table' ? 'tables' : 'views');
  const node = entry.kind === 'table' ? tableNodeId(folder, entry.id) : viewNodeId(folder, entry.id);
  const path = [schema, folder, node];
  if (hit.kind === 'column') {
    let parent = folderId(node, 'columns');
    path.push(parent);
    for (const id of hit.column.ids) {
      parent = columnNodeId(parent, id);
      path.push(parent);
    }
  }
  return path;
}
