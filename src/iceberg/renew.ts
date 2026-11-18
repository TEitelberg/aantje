import type { IcebergName } from './copy';
import { dropEmptyTable } from './rest';
import { icebergRenewal } from './statements';
import type { IcebergTarget } from './target';

/**
 * Before each table of a sync to a Fabric lakehouse: asks the sign-in for its token without asking the user, and when it
 * is a new one (the Microsoft account renews its token about every hour), puts it into the engine. A long sync so keeps
 * writing after the first token ran out. Every new token joins `hidden`, so that no failure shows it. Does nothing for
 * any other target or without `fresh`.
 */
export function tokenRenewal(
  target: IcebergTarget,
  first: string | undefined,
  fresh: (() => Promise<string | undefined>) | undefined,
  run: (sql: string) => Promise<unknown>,
  hidden: string[],
): { readonly renew: () => Promise<void>; readonly token: () => string | undefined } {
  let current = first;
  return {
    renew: async () => {
      if (!fresh || !target.fabric) return;
      const next = await fresh().catch(() => undefined);
      if (next === undefined || next === current) return;
      const statements = icebergRenewal(target, next) ?? [];
      hidden.push(next);
      for (const sql of statements) await run(sql);
      current = next;
    },
    // The token the engine holds now, for the REST calls of the sync.
    token: () => current,
  };
}

/**
 * For a Fabric lakehouse: drops an empty table that a failed write left in the catalog of OneLake (see
 * `dropEmptyTable`), before a table is written and after a write failed, and tells it. Never throws.
 */
export function leftoverCleanup(
  target: IcebergTarget,
  token: () => string | undefined,
  told: ((line: string, ok: boolean) => void) | undefined,
  drop: typeof dropEmptyTable = dropEmptyTable,
): (table: IcebergName) => Promise<void> {
  return async (table) => {
    if (!target.fabric) return;
    const dropped = await drop(target, token(), table).catch(() => false);
    if (dropped) {
      told?.(
        `removed the empty table ${table.namespace}.${table.name} that a failed write had left in the lakehouse`,
        true,
      );
    }
  };
}
