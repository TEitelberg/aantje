import type { ConnectionStore } from '../connections/store';
import { createPropertiesReport } from '../properties-report/commands.vscode';
import type { PropertiesReport } from '../properties-report/model';
import { createStorageReport } from '../storage-report/commands.vscode';
import type { ReportHostEnv } from './host.vscode';
import type { TableActionEnv } from './table-actions.vscode';

/**
 * The Storage and the Properties report. The Properties report offers a button for the Storage report and the Storage
 * report one for the Properties; the Storage report finds the Properties report through a binding that is set right
 * after it.
 */
export function createReportPair(
  host: ReportHostEnv,
  tableActions: TableActionEnv,
  store: Pick<ConnectionStore, 'get'>,
) {
  let properties: PropertiesReport | undefined = undefined;
  const storage = createStorageReport({
    ...host,
    ...tableActions,
    showProperties: async (profile) => {
      await properties?.show(profile);
    },
  });
  properties = createPropertiesReport({
    ...host,
    actions: {
      showStorage: async (connectionId) => {
        const profile = store.get(connectionId);
        if (profile) {
          await storage.show(profile);
        }
      },
    },
  });
  return { storage, properties };
}
