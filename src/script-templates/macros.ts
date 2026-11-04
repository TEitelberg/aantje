import { qualifiedName } from '../catalog/ddl';
import type { MacroInfo } from '../catalog/model';
import { PREVIEW_LIMIT } from '../data/types';
import { commented, newestNote } from '../script';
import { limited } from './common';
import type { Folder, Ref, Tree } from './common';

// One call per overload; each parameter without a default becomes `<argN>`, and `open` marks such a call.
function macroCalls(schemaName: string, macro: MacroInfo): { call: string; open: boolean }[] {
  const name = qualifiedName(schemaName, macro.name);
  return macro.implementations.map(({ parameters }) => {
    const required = parameters.filter(({ defaultValue }) => defaultValue === null);
    const args = required.map((_, index) => `<arg${index + 1}>`).join(', ');
    return {
      call:
        macro.kind === 'scalar'
          ? `SELECT ${name}(${args});`
          : `SELECT * FROM ${name}(${args}) LIMIT ${PREVIEW_LIMIT};`,
      open: required.length > 0,
    };
  });
}

export function selectMacro(tree: Tree, ref: Ref<'macro'>): string {
  const [first, ...others] = macroCalls(ref.schema.name, ref.macro);
  return [
    ...(first?.open ? ['-- Replace the <arg> placeholders with values.'] : []),
    ...(others.length > 0 ? ['-- The call is for the first overload; the others follow as comments.'] : []),
    ...newestNote(tree, ref.connectionId),
    ...(first ? [first.call] : []),
    ...others.map(({ call }) => commented(call)),
  ].join('\n');
}

export function selectMacros(tree: Tree, ref: Folder<'macros'>): string {
  if (ref.macros.length === 0) {
    return '-- This schema has no macros.';
  }
  const { shown, more } = limited(ref.macros);
  return [
    '-- A call of each macro, with its first overload. A call that needs arguments is a comment: replace the <arg> placeholders and remove the "-- ".',
    ...newestNote(tree, ref.connectionId, { several: true }),
    '',
    ...shown.flatMap((macro) =>
      macroCalls(ref.schema.name, macro)
        .slice(0, 1)
        .map((first) => (first.open ? commented(first.call) : first.call)),
    ),
    ...(more.length > 0 ? ['', ...more] : []),
  ].join('\n');
}
