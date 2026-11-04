import type { CatalogReader } from '../catalog/model';
import { buildHistory } from './model';
import type { SchemaHistoryData } from './model';

const VERSION_LIMIT = 100;

/** Reads the schema history of a table and the newest snapshot. */
export async function readSchemaHistory(
  reader: CatalogReader,
  connection: string,
  tableId: number,
  signal?: AbortSignal,
): Promise<SchemaHistoryData> {
  const [history, info] = await Promise.all([
    reader.schemaHistory(tableId, VERSION_LIMIT, signal),
    reader.info(),
  ]);
  return buildHistory(connection, tableId, info.latestSnapshot, history);
}
