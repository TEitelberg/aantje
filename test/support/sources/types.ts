import type { Driver } from '../../../src/catalog/drivers/driver';

/** One way to open the fixture catalog; the contract suites run against every available source. */
export interface CatalogSource {
  readonly name: 'sqlite' | 'duckdb' | 'postgres' | 'quack';
  /** Why this source cannot run here (e.g. no Docker); undefined when it can. */
  skipReason(): string | undefined;
  /** Opens a new read-only driver on the fixture catalog. The caller closes it. */
  open(): Promise<Driver>;
}
