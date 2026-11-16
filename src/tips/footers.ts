// The row groups of one Parquet data file of the lake, read from its footer in a one-shot read-only session.
import { quoteLiteral } from '../catalog/ddl';
import { withLakeSession } from '../data/lake-session';
import { escapeGlob } from '../data/store-sql';
import type { DataAccess } from '../data/types';
import type { RowGroupRanges } from './collect';

/** The longest a footer read may take; a slow storage then gives no sort-order tip for the table. */
const FOOTER_LIMIT_MS = 5000;

/**
 * Reads the minimum and maximum of a column in each row group of a data file. The location is written as a literal
 * with its glob characters escaped, so it names exactly that file; the caller passes only files below the data path.
 */
export function footerRanges(access: () => Promise<DataAccess>): RowGroupRanges {
  return async (location, column, signal) => {
    const rows = await withLakeSession(await access(), signal, (session) =>
      session.rows(
        `SELECT stats_min_value, stats_max_value FROM parquet_metadata(${quoteLiteral(escapeGlob(location))}) WHERE path_in_schema = ${quoteLiteral(column)} ORDER BY row_group_id`,
        FOOTER_LIMIT_MS,
      ),
    );
    return rows.map(([min, max]) => ({
      min: typeof min === 'string' ? min : null,
      max: typeof max === 'string' ? max : null,
    }));
  };
}
