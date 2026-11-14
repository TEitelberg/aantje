import type * as vscode from 'vscode';
import { catalogAt, shownSnapshot } from '../actions';
import { guarded, offerOnErrors, showConnectFirst } from '../command.vscode';
import type { Register } from '../command.vscode';
import type { S3CredentialStore } from '../data/credentials';
import type { DataAccessFactory } from '../data/resolve';
import type { FindingScope, HealthReport, HealthRequest } from '../health/model';
import { runHealthCheck } from '../health/run';
import type { HealthRun } from '../health/run';
import { connectionClosed } from '../messages';
import { reportPanels } from '../shell/host.vscode';
import { scopeOfNode } from '../shell/scope';
import type { ReportHostEnv } from '../shell/host.vscode';
import type { TableActionEnv } from '../shell/table-actions.vscode';
import { createHealthController } from './controller';
import type { HealthTarget } from './controller';
import { healthKind } from './kind';
import { offerFor, scopeForOffer } from './offer';
import type { HealthOffer } from './offer';
import { healthPerformer } from './perform.vscode';

const COMMAND = 'aantje.checkHealth';
const TABLE_COMMAND = 'aantje.checkTableHealth';
const GOAL = 'check its health';

interface HealthCommandEnv extends ReportHostEnv, TableActionEnv {
  readonly dataAccess: DataAccessFactory;
  readonly credentials: Pick<S3CredentialStore, 'source'>;
  /** The environment of the extension host; a variable in it can name the S3 endpoint to suggest. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly register: Register;
}

/** Check Health (of the lake or a schema), Check Table Health, the panel they open and the button in the messages of failed reads. */
export function registerHealthCommands(env: HealthCommandEnv): vscode.Disposable[] {
  const { store, tree } = env;

  const panels = reportPanels(env, healthKind, {
    onAction: (message, _data, key) => {
      void guarded(env.logger, COMMAND, () => controller.act(key, message));
    },
    onClose: (key) => controller.close(key),
  });

  async function check(
    { connectionId }: HealthTarget,
    request: HealthRequest,
    run: HealthRun,
  ): Promise<HealthReport> {
    const { reader } = catalogAt(tree, connectionId, GOAL);
    const profile = store.get(connectionId);
    if (!profile) {
      throw connectionClosed(GOAL);
    }
    const access = await env.dataAccess(profile, undefined);
    // Only a connection on the machine's S3 settings asks where the keys come from; any other storage knows its own sign-in.
    const credentialsFrom =
      access.storage === undefined || access.storage.legacy === 'settings'
        ? await env.credentials.source()
        : undefined;
    return runHealthCheck(
      { reader, access, env: env.env, ...(credentialsFrom ? { credentialsFrom } : {}) },
      request,
      run,
    );
  }

  const controller = createHealthController({
    panels,
    logger: env.logger,
    check,
    perform: healthPerformer(env),
  });

  /** The target of a connection that is open: its name and the snapshot its tree shows. */
  function targetOf(connectionId: string, scope: FindingScope): HealthTarget | undefined {
    const profile = store.get(connectionId);
    const snapshot = shownSnapshot(tree.state(connectionId));
    if (!profile || !tree.reader(connectionId) || snapshot === undefined) {
      showConnectFirst(GOAL);
      return undefined;
    }
    return { connectionId, connectionName: profile.name, scope, snapshot };
  }

  const openAndRun = (target: HealthTarget | undefined): void => {
    if (!target) return;
    controller.open(target, { run: true });
    env.active.select(target.connectionId);
  };

  async function openFromError(offer: HealthOffer): Promise<void> {
    const reader = tree.reader(offer.connectionId);
    const state = tree.state(offer.connectionId);
    const shown = shownSnapshot(state);
    if (!reader || shown === undefined) {
      showConnectFirst(GOAL);
      return;
    }
    const scope = await scopeForOffer(offer, reader, shown, state.latestSnapshot);
    openAndRun(targetOf(offer.connectionId, scope));
  }

  return [
    { dispose: () => controller.dispose() },
    { dispose: () => panels.dispose() },
    // A failed read that the check can look into gets its button: Check Health or Check Table Health.
    offerOnErrors((error) => {
      const offer = offerFor(error);
      return (
        offer && { label: offer.label, run: () => guarded(env.logger, COMMAND, () => openFromError(offer)) }
      );
    }),
    env.register(COMMAND, (node) => {
      const scope = node && scopeOfNode(node.ref);
      if (node && scope) openAndRun(targetOf(node.ref.connectionId, scope));
    }),
    env.register(TABLE_COMMAND, (node) => {
      if (node?.ref.kind !== 'table') return;
      const { table, schema, connectionId } = node.ref;
      openAndRun(
        targetOf(connectionId, { kind: 'table', id: table.id, schema: schema.name, name: table.name }),
      );
    }),
  ];
}
