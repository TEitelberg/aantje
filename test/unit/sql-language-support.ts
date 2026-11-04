import type { CatalogReader } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { catalogOfReader } from '../../src/sql/catalog';
import type { SqlCatalog } from '../../src/sql/catalog';
import { contextAt } from '../../src/sql/context';
import type { CursorContext } from '../../src/sql/context';
import type { LanguageService } from '../../src/sql/language';
import { LATEST_SNAPSHOT } from '../support/expected';
import { HISTORY_LATEST_SNAPSHOT } from '../support/expected-history';
import { historySources } from '../support/sources/history';
import { sqliteSource } from '../support/sources/sqlite';

/** The text of a test without its cursor mark: the first `|` is the cursor, any later `|` stays. */
export function marked(text: string): { text: string; offset: number } {
  const offset = text.indexOf('|');
  if (offset < 0) throw new Error(`No cursor mark in ${JSON.stringify(text)}`);
  return { text: text.slice(0, offset) + text.slice(offset + 1), offset };
}

export interface OpenCatalog {
  readonly catalog: SqlCatalog;
  readonly reader: CatalogReader;
  close(): Promise<void>;
}

function opened(reader: CatalogReader, snapshot: number): OpenCatalog {
  return { catalog: catalogOfReader(reader, snapshot), reader, close: () => reader.close() };
}

/** The checked-in fixture: `sales.orders` (STRUCT, LIST and MAP columns), the view `sales.big_orders`, `main.plain`. */
export async function openSales(snapshot = LATEST_SNAPSHOT): Promise<OpenCatalog> {
  return opened(createCatalogReader(await sqliteSource.open()), snapshot);
}

/** The history fixture: `shop.events` (partitioned), `main.evolving` or `main.evolved`, macros, a view. */
export async function openHistory(snapshot = HISTORY_LATEST_SNAPSHOT): Promise<OpenCatalog> {
  const source = historySources[0];
  if (!source) throw new Error('The history fixture has no sqlite source.');
  return opened(createCatalogReader(await source.open()), snapshot);
}

/** The context at the cursor of a marked text. */
export async function contextOf(
  service: LanguageService,
  text: string,
  lake = 'lake',
): Promise<CursorContext> {
  const cursor = marked(text);
  return contextAt(await service.tokenize(cursor.text), cursor.offset, lake);
}
