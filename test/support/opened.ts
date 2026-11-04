import type { CatalogReader } from '../../src/catalog/model';
import type { OpenedCatalog } from '../../src/catalog/open';

/** A reader as `openCatalog` hands it out: with the info of the check that the catalog passed. */
export async function opened(reader: CatalogReader | Promise<CatalogReader>): Promise<OpenedCatalog> {
  const ready = await reader;
  return { reader: ready, info: await ready.info() };
}
