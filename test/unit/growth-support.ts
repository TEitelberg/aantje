import { readGrowth } from '../../src/growth/read';
import type { GrowthData } from '../../src/growth/model';
import type { EditedCatalogs } from '../support/edited-catalog';
import { historyFixture } from '../support/sources/history';
import { timeStatements } from './activity-support';
import type { Authored } from './activity-support';

/** The growth data of the history fixture with the times of `timeStatements`, read with the real reader on an edited SQLite copy. */
export async function historyGrowth(
  catalogs: EditedCatalogs,
  options: { focus?: number | null; limit?: number; authors?: readonly Authored[] } = {},
): Promise<GrowthData> {
  const reader = await catalogs.open(historyFixture.sqlite, ...timeStatements(options.authors ?? []));
  return readGrowth(reader, 'History', options.focus ?? null, undefined, options.limit);
}
