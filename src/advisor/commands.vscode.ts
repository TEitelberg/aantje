import * as vscode from 'vscode';
import type { Register } from '../command.vscode';
import type { ConnectionProfile } from '../connections/profile';
import type { DataAccessFactory } from '../data/resolve';
import { openReport } from '../shell/host.vscode';
import type { ReportHostEnv } from '../shell/host.vscode';
import { scopeKey, scopeOfNode, scopeSuffix } from '../shell/scope';
import { performTableAction } from '../shell/table-actions.vscode';
import type { TableActionEnv } from '../shell/table-actions.vscode';
import { planAdvisorAction } from './actions';
import type { AdvisorPlan } from './actions';
import { advisorKind } from './kind';
import type { AdvisorData, AdvisorScope } from './model';
import type { AdvisorAction } from './protocol';
import { readAdvisor } from './read';
import { advisorScriptOf } from './script';

const COMMAND = 'aantje.showAdvisor';
const GOAL = 'show its maintenance advice';

interface AdvisorCommandEnv extends ReportHostEnv, TableActionEnv {
  readonly dataAccess: DataAccessFactory;
  readonly showStorage: (profile: ConnectionProfile, scope: AdvisorScope) => Promise<void>;
  /** Opens the Health Check of the connection, or of the schema with this id. */
  readonly checkHealth: (connectionId: string, schemaId?: number) => Promise<void>;
  readonly register: Register;
}

/** The Maintenance Advisor: one panel per connection and scope (the lake or one schema). It measures with dry runs and opens scripts; it changes nothing. */
export function registerAdvisorCommand(env: AdvisorCommandEnv): vscode.Disposable[] {
  async function openScript(profile: ConnectionProfile, data: AdvisorData): Promise<void> {
    const text = advisorScriptOf(data);
    if (text === undefined) {
      void vscode.window.showInformationMessage('The Maintenance Advisor has no recommendation to script.');
      return;
    }
    await env.openSql(profile.id, text);
  }

  const report = openReport<AdvisorData, AdvisorAction, never, AdvisorPlan, { readonly scope: AdvisorScope }>(
    env,
    {
      command: COMMAND,
      kind: advisorKind,
      noun: 'maintenance advisor',
      goal: GOAL,
      keyOf: (profile, { scope }) => scopeKey(profile.id, scope),
      open: (reader, profile, { scope }) => ({
        progress: `Measuring the maintenance of "${profile.name}"...`,
        read: async (signal) =>
          readAdvisor(
            { reader, access: await env.dataAccess(profile, undefined) },
            profile.name,
            new Date(),
            signal,
            scope,
          ),
        title: () => `Maintenance Advisor · ${profile.name}${scopeSuffix(scope)}`,
      }),
      planAction: planAdvisorAction,
      perform: async (plan, profile, data) => {
        switch (plan.action) {
          case 'showStorage':
            await env.showStorage(profile, data.scope);
            return;
          case 'maintenanceScript':
            await openScript(profile, data);
            return;
          case 'checkHealth':
            await env.checkHealth(profile.id, data.scope.kind === 'schema' ? data.scope.id : undefined);
            return;
          default:
            await performTableAction(env, profile.id, plan, data.snapshot);
        }
      },
    },
  );

  return [
    { dispose: () => report.dispose() },
    report.command(env.register, (ref) => {
      const scope = scopeOfNode(ref);
      return scope && { scope };
    }),
  ];
}
