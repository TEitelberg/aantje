import type { WizardUi } from '../connections/ports';
import { azureAccountOf } from '../connections/profile';
import type { PostgresProfile } from '../connections/profile';
import { userMessageOf } from '../errors';
import type { Logger } from '../log';
import { deleteLake, followDeletion } from './delete-lake';
import type { FollowDeps } from './delete-lake';
import type { LakeRegistry } from './registry';

export interface DeleteFlowDeps {
  readonly arm: Parameters<typeof deleteLake>[1] & FollowDeps['arm'];
  readonly signIn: (tenantId?: string) => Promise<void>;
  readonly registry: Pick<LakeRegistry, 'get' | 'remove'>;
  /** Removes the connection with its password. */
  readonly removeConnection: (profile: PostgresProfile) => Promise<void>;
  readonly log: Logger;
  readonly sleep: (ms: number) => Promise<void>;
  /** Runs the follow-up of the deletion, which ends minutes later, without holding the command. */
  readonly background: (task: Promise<void>) => void;
}

/** Deletes the Azure resources of a lake that aantje created, after the name was typed and a second confirmation. */
export async function deleteLakeFlow(
  ui: WizardUi,
  profile: PostgresProfile,
  deps: DeleteFlowDeps,
): Promise<boolean> {
  const lake = deps.registry.get(profile.id);
  if (!lake) {
    ui.error(
      `aantje did not create "${profile.name}", so it does not delete its Azure resources. Delete them in the Azure portal, then remove the connection.`,
    );
    return false;
  }
  const typed = await ui.input({
    title: `Delete Azure DuckLake "${profile.name}"`,
    prompt: `This deletes the data. Type the name of the lake, "${profile.name}", to go on.`,
    validate: (value) => (value.trim() === profile.name ? undefined : 'The name does not match.'),
  });
  if (typed === undefined) {
    return false;
  }
  const scope = lake.createdResourceGroup
    ? `the resource group "${lake.resourceGroup}" if it holds nothing but this lake, otherwise only`
    : 'only';
  const confirmed = await ui.confirm(
    `Delete ${scope} the PostgreSQL server ${lake.serverName} and the storage account ${lake.storageAccountName}? All tables and data files of the lake are lost and cannot be restored. The connection "${profile.name}" is removed too.`,
    'Delete permanently',
  );
  if (!confirmed) {
    return false;
  }
  deps.log.info(
    `Delete Azure DuckLake "${profile.name}": resource group "${lake.resourceGroup}" of the subscription ${lake.subscriptionId}, PostgreSQL server "${lake.serverName}", storage account "${lake.storageAccountName}".`,
  );
  await deps.signIn(azureAccountOf(profile)?.tenant);
  const deleted = await ui.withProgress(`Deleting "${profile.name}"...`, () =>
    deleteLake(lake, deps.arm, deps.log),
  );
  await deps.removeConnection(profile);
  await deps.registry.remove(profile.id);
  deps.log.info(`Removed the connection "${profile.name}" and its password.`);
  ui.info(
    `Started deleting the ${deleted.scope === 'resource group' ? 'resource group' : 'server and storage account'} of "${profile.name}". Azure finishes in the background; the output "aantje" shows when it is done.`,
  );
  deps.background(
    followDeletion(deleted.started, deps).catch((error: unknown) => {
      deps.log.error(`Deleting the Azure DuckLake "${profile.name}" did not finish.`, error);
      ui.error(
        `${userMessageOf(error)} What is not deleted keeps costing money: check the resource group "${lake.resourceGroup}" in the Azure portal.`,
      );
    }),
  );
  return true;
}
