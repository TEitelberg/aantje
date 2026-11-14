// The completion items of DuckDB's own constructs: lambda parameters and the options of `COPY ... TO`.
import type { Env } from './completion-env';
import { COPY_FORMATS, COPY_TO_ANY_FORMAT, COPY_TO_OPTIONS } from './duckdb';

/** The parameters of the lambdas around the cursor, ahead of the columns of the relations. */
export function localDrafts({ drafts, context, quote }: Env): void {
  const seen = new Set<string>();
  for (const name of context.locals) {
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    drafts.push({
      label: name,
      kind: 'column',
      insertText: quote(name),
      detail: 'lambda parameter',
      group: 0,
      rank: seen.size - 1 - context.locals.length,
    });
  }
}

/** The options of `COPY ... TO` that are not given yet: those of the format first, then those of every format. */
export function copyOptionDrafts({ drafts, context }: Env): void {
  const { copy } = context;
  if (!copy || context.qualifier.length > 0) return;
  const given = new Set(copy.given);
  const lists = [COPY_TO_OPTIONS[copy.format] ?? [], COPY_TO_ANY_FORMAT];
  for (const [group, names] of lists.entries()) {
    for (const [rank, name] of names.entries()) {
      if (given.has(name)) continue;
      const label = name.toUpperCase();
      drafts.push({
        label,
        kind: 'parameter',
        insertText: label,
        detail: group === 0 ? copy.format : undefined,
        group,
        rank,
      });
    }
  }
}

/** The formats after FORMAT. */
export function copyFormatDrafts({ drafts }: Env): void {
  for (const [rank, name] of COPY_FORMATS.entries()) {
    drafts.push({ label: name, kind: 'keyword', insertText: name, group: 0, rank });
  }
}
