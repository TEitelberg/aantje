import type { MacroInfo, SchemaInfo, ViewInfo } from '../catalog/model';
import { pickerLabel } from '../messages';
import type { CatalogObjects } from '../dependencies/graph';
import { macroNodeKind } from '../dependencies/graph';
import type { GraphKey } from '../dependencies/graph';
import { collator } from '../order';

// The tables, views and macros that Generate Scripts offers, and the rows of its two pickers.

interface Named {
  readonly schema: SchemaInfo;
  readonly id: number;
  readonly name: string;
}

/** A table, view or macro of the lake at the snapshot. */
export type LakeObject =
  | (Named & { readonly kind: 'table' })
  | (Named & { readonly kind: 'view'; readonly view: ViewInfo })
  | (Named & { readonly kind: 'macro'; readonly macro: MacroInfo });

const KIND_RANK: Record<LakeObject['kind'], number> = { table: 0, view: 1, macro: 2 };

/** A scalar macro before a table macro of the same name. */
const macroRank = (object: LakeObject): number =>
  object.kind === 'macro' && object.macro.kind === 'table' ? 1 : 0;

/** By schema, then tables, views and macros, each by name. */
export const compareObjects = (a: LakeObject, b: LakeObject): number =>
  collator.compare(a.schema.name, b.schema.name) ||
  KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
  collator.compare(a.name, b.name) ||
  macroRank(a) - macroRank(b) ||
  a.id - b.id;

/** The tables, views and macros of the lake, or of one schema, in the order of `compareObjects`. */
export function lakeObjects(objects: CatalogObjects, schemaId?: number): LakeObject[] {
  const schemas = new Map(objects.schemas.map((schema) => [schema.id, schema]));
  const inScope = (id: number): SchemaInfo | undefined =>
    schemaId === undefined || schemaId === id ? schemas.get(id) : undefined;
  const found: LakeObject[] = [];
  for (const { kind, id, name, schemaId: owner } of objects.entries) {
    const schema = inScope(owner);
    if (schema && kind === 'table') found.push({ kind, schema, id, name });
  }
  for (const view of objects.views) {
    const schema = inScope(view.schemaId);
    if (schema) found.push({ kind: 'view', schema, id: view.id, name: view.name, view });
  }
  for (const macro of objects.macros) {
    const schema = inScope(macro.schemaId);
    if (schema) found.push({ kind: 'macro', schema, id: macro.id, name: macro.name, macro });
  }
  return found.toSorted(compareObjects);
}

/** The object as the dependency graph names it. */
export function graphKeyOf(object: LakeObject): GraphKey {
  if (object.kind !== 'macro') return { kind: object.kind, id: object.id };
  return { kind: macroNodeKind(object.macro), id: object.id };
}

const kindText = (object: LakeObject): string =>
  object.kind === 'macro' ? `${object.macro.kind} macro` : object.kind;

export interface ObjectItem {
  readonly label: string;
  readonly description: string;
  readonly picked: true;
  readonly value: LakeObject;
}

/** `<schema>.<name>` with the kind as description, all selected. */
export const objectItems = (objects: readonly LakeObject[]): ObjectItem[] =>
  objects.map((object) => ({
    label: pickerLabel(`${object.schema.name}.${object.name}`),
    description: kindText(object),
    picked: true,
    value: object,
  }));

export type Output = 'document' | 'files';

export const OUTPUTS: readonly { readonly label: string; readonly value: Output }[] = [
  { label: 'One SQL document', value: 'document' },
  { label: 'One file per object', value: 'files' },
];
