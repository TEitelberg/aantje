import { qualifiedName, quoteIdentifier, typeName } from './catalog/ddl';
import type { MacroInfo, MacroParameter } from './catalog/model';
import { visibleLine } from './markdown';
import { newestNote } from './script';
import type { CatalogTree } from './tree/model';

// Execute Macro: the call of a macro with the values the user typed, opened in a SQL document; nothing runs. Pure.

/** `(net, rate := 1.19)`: an overload of a macro as the picker shows it. */
export const overloadText = (parameters: readonly MacroParameter[]): string =>
  visibleLine(
    `(${parameters
      .map(
        ({ name, type, defaultValue }) =>
          `${name}${type === null ? '' : ` ${typeName(type)}`}${defaultValue === null ? '' : ` := ${defaultValue}`}`,
      )
      .join(', ')})`,
  );

/** The hint under the input of a parameter: what it takes, its declared type and its default. */
export function parameterHint({ type, defaultValue }: MacroParameter): string {
  return [
    `SQL for the value, for example 42, 'EUR' or DATE '2026-09-01'${type === null ? '' : `; declared type ${visibleLine(typeName(type))}`}.`,
    defaultValue === null ? 'A value is needed.' : `Empty keeps the default: ${visibleLine(defaultValue)}.`,
  ].join(' ');
}

/**
 * The call of one overload with the values in parameter order (`undefined` or blank: none typed). A parameter without
 * a default is passed by position, one with a default by name (`"rate" := 0.19`) and only when a value was typed, so
 * that an empty input keeps the default. The values are the user's SQL; names are quoted, no catalog text is copied.
 */
export function macroCall(
  schemaName: string,
  macro: Pick<MacroInfo, 'name' | 'kind'>,
  parameters: readonly MacroParameter[],
  values: readonly (string | undefined)[],
): string {
  const typed = (index: number): string | undefined => {
    const value = values[index]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  const args = parameters.flatMap((parameter, index) => {
    const value = typed(index);
    // The input asks until a value is typed; the placeholder of Script as SELECT keeps a gap visible all the same.
    if (parameter.defaultValue === null) return [value ?? `<arg${index + 1}>`];
    return value === undefined ? [] : [`${quoteIdentifier(parameter.name)} := ${value}`];
  });
  const call = `${qualifiedName(schemaName, macro.name)}(${args.join(', ')})`;
  return macro.kind === 'table' ? `SELECT * FROM ${call};` : `SELECT ${call};`;
}

/** The text of the document: the call, under a note while the tree shows an older snapshot. */
export const macroCallScript = (
  tree: Pick<CatalogTree, 'state'>,
  connectionId: string,
  call: string,
): string => [...newestNote(tree, connectionId), call].join('\n');
