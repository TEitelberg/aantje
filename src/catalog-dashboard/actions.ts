import { needsVacuum, vacuumScript, vacuumTables } from './model';
import type { DashboardData } from './model';
import type { DashboardAction } from './protocol';

/** The script of an action, for a table that waits for a vacuum or for all of them; undefined when the data offers none. */
export function planDashboardAction(data: DashboardData, message: DashboardAction): string | undefined {
  const { schema } = data.database;
  if (schema === undefined) return undefined;
  if (message.action === 'vacuumAll') {
    const tables = vacuumTables(data);
    return tables.length === 0
      ? undefined
      : vacuumScript(
          schema,
          tables.map(({ name }) => name),
        );
  }
  const table = message.table === undefined ? undefined : data.database.tables[message.table];
  return table && data.database.engine === 'postgres' && needsVacuum(table)
    ? vacuumScript(schema, [table.name])
    : undefined;
}
