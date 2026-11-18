import { sortScript } from '../tips/scripts';
import type { PartitionData } from './model';
import type { PartitionAction } from './protocol';
import { partitionScript } from './script';

export type PartitionPlan =
  { readonly action: 'script'; readonly text: string } | { readonly action: 'showStatistics' };

/** The plan of a request, from the extension's data: the script of a candidate it sent, or of its sort order. */
export function planPartitionAction(
  data: PartitionData,
  message: PartitionAction,
): PartitionPlan | undefined {
  const { table, current } = data;
  switch (message.action) {
    case 'openScript': {
      const candidate = message.candidate === undefined ? undefined : data.candidates[message.candidate];
      return (
        candidate && {
          action: 'script',
          text: partitionScript(table, candidate, current.partitioning !== null),
        }
      );
    }
    case 'sortScript':
      return data.sortOrder
        ? {
            action: 'script',
            text: sortScript(table.schema, table.name, data.sortOrder.column, {
              rows: table.rows,
              bytes: table.sizeBytes,
              replaces: current.sortOrder !== null,
            }),
          }
        : undefined;
    case 'showStatistics':
      return { action: 'showStatistics' };
  }
}
