import { openReport } from '../shell/host.vscode';
import type { ReportHostEnv } from '../shell/host.vscode';
import { propertiesKind } from './kind';
import type { PropertiesActionId, PropertiesReport } from './model';

const COMMAND = 'aantje.showProperties';

interface PropertiesReportEnv extends ReportHostEnv {
  /** The actions of the page that something runs; the page shows a button for each of them. */
  readonly actions?: Partial<Record<PropertiesActionId, (connectionId: string) => Promise<void>>>;
}

/** The Properties report: one panel per connection, opened and refreshed like the other reports. */
export function createPropertiesReport(env: PropertiesReportEnv): PropertiesReport {
  const actions = env.actions ?? {};
  const report = openReport(env, {
    command: COMMAND,
    kind: propertiesKind,
    noun: 'properties report',
    goal: 'show its properties',
    keyOf: (profile) => profile.id,
    open: (reader, profile) => ({
      progress: `Reading the properties of "${profile.name}"...`,
      read: async () => ({
        connection: profile.name,
        properties: await reader.properties(),
        actions: Object.keys(actions) as PropertiesActionId[],
      }),
      title: () => `Properties · ${profile.name}`,
    }),
    planAction: (data, { action }) => (data.actions.includes(action) ? actions[action] : undefined),
    perform: (run, profile) => run(profile.id),
  });
  return { show: (profile) => report.show(profile, {}), dispose: () => report.dispose() };
}
