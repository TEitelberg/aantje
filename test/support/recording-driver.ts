import type { Driver } from '../../src/catalog/drivers/driver';
import type { Query } from '../../src/catalog/queries/shared';

export interface RecordingDriver extends Driver {
  /** The SQL of every statement, in the order sent. */
  readonly statements: string[];
  /** How often the statement of `query` was sent, whatever its parameters. */
  count(query: Query): number;
}

/** Passes every statement to `driver` and records it, to count what a read sends to the real engine. */
export function recording(driver: Driver): RecordingDriver {
  const statements: string[] = [];
  return {
    statements,
    count: (query) => statements.filter((sql) => sql === query.sql).length,
    query: (sql, params, options) => {
      statements.push(sql);
      return driver.query(sql, params, options);
    },
    close: () => driver.close(),
  };
}
