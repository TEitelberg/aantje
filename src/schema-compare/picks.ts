import type { CatalogEntry, SchemaInfo } from '../catalog/model';
import { pickerLabel } from '../messages';
import { collator } from '../order';
import type { Side } from './tables';

// The rows of the three pickers of Schema Compare.

export type Mode = 'tables' | 'schemas';

export const MODES: readonly { readonly label: string; readonly value: Mode }[] = [
  { label: 'Two tables', value: 'tables' },
  { label: 'Two schemas', value: 'schemas' },
];

/** What one side is: a table of a catalog, or a schema. */
export type Picked =
  | { readonly side: Side; readonly table: CatalogEntry }
  | { readonly side: Side; readonly schema: SchemaInfo };

export interface SideItem {
  readonly label: string;
  readonly description: string;
  readonly value: Picked;
}

const label = (side: Side, name: string): string => pickerLabel(`${side.connectionName} · ${name}`);

/** `<connection> · <schema>.<table>` for the tables among the entries, by schema and name. */
export const tableItems = (side: Side, entries: readonly CatalogEntry[]): SideItem[] =>
  entries
    .filter(({ kind }) => kind === 'table')
    .toSorted((a, b) => collator.compare(a.schemaName, b.schemaName) || collator.compare(a.name, b.name))
    .map((table) => ({
      label: label(side, `${table.schemaName}.${table.name}`),
      description: `@${side.snapshot}`,
      value: { side, table },
    }));

/** `<connection> · <schema>` for each schema, by name. */
export const schemaItems = (side: Side, schemas: readonly SchemaInfo[]): SideItem[] =>
  schemas
    .toSorted((a, b) => collator.compare(a.name, b.name))
    .map((schema) => ({
      label: label(side, schema.name),
      description: `@${side.snapshot}`,
      value: { side, schema },
    }));
