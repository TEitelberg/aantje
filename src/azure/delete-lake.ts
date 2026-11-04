import { AantjeError, isAantjeError, userMessageOf } from '../errors';
import type { Logger } from '../log';
import { isPassingPollFailure } from './arm';
import type { ArmClient } from './arm';
import type { CreatedLake } from './create-lake';
import { capitalized, elapsed, TOLERATED_POLL_FAILURES } from './operations';
import type { ArmOperation } from './operations';

export type DeleteScope = 'resource group' | 'resources';

type DeleteArm = Pick<
  ArmClient,
  'listGroupResources' | 'deleteResourceGroup' | 'deleteServer' | 'deleteStorageAccount'
>;

/** A delete that Azure accepted: what it removes, and where to follow it. */
export interface StartedDeletion {
  /** For example `the resource group "rg"`. */
  readonly what: string;
  readonly operation: ArmOperation;
}

export interface DeletedLake {
  readonly scope: DeleteScope;
  readonly started: readonly StartedDeletion[];
}

export interface FollowDeps {
  readonly arm: Pick<ArmClient, 'operationDone'>;
  readonly log: Pick<Logger, 'info' | 'warn'>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
}

const FOLLOW_POLL_MS = 15_000;
const FOLLOW_TIMEOUT_MS = 60 * 60_000;
// As while waiting for a deployment: a few unanswered polls in a row pass.

/** The resource ids a delete acts on, as Azure lists them. */
export function lakeResourceIds(lake: CreatedLake): { readonly server: string; readonly storage: string } {
  const group = `/subscriptions/${lake.subscriptionId}/resourceGroups/${lake.resourceGroup}`;
  return {
    server: `${group}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${lake.serverName}`,
    storage: `${group}/providers/Microsoft.Storage/storageAccounts/${lake.storageAccountName}`,
  };
}

/**
 * Deletes the lake. The resource group goes with it only when this lake's creation made the group and the group holds
 * nothing else now; in every other case just the server and the storage account are deleted. Azure finishes the
 * deletion in the background; `followDeletion` waits for it.
 */
export async function deleteLake(
  lake: CreatedLake,
  arm: DeleteArm,
  log: Pick<Logger, 'info'>,
): Promise<DeletedLake> {
  const ids = lakeResourceIds(lake);
  const group = `the resource group "${lake.resourceGroup}"`;
  if (lake.createdResourceGroup) {
    const ours = new Set([ids.server.toLowerCase(), ids.storage.toLowerCase()]);
    const found = await arm.listGroupResources(lake.subscriptionId, lake.resourceGroup);
    const others = found.filter(({ id }) => !ours.has(id.toLowerCase()));
    log.info(`${capitalized(group)} holds: ${found.map(resourceLabel).join(', ') || 'nothing'}.`);
    if (others.length === 0) {
      log.info(`aantje created ${group} and it holds nothing but the lake: deleting the resource group.`);
      return {
        scope: 'resource group',
        started: [
          await start(group, () => arm.deleteResourceGroup(lake.subscriptionId, lake.resourceGroup), log),
        ],
      };
    }
    log.info(
      `${capitalized(group)} holds more than the lake (${others.map(resourceLabel).join(', ')}): deleting only the server and the storage account.`,
    );
  } else {
    log.info(`aantje did not create ${group}: deleting only the server and the storage account.`);
  }
  const server = await start(
    `the PostgreSQL server "${lake.serverName}"`,
    () => arm.deleteServer(ids.server),
    log,
  );
  const storage = await start(
    `the storage account "${lake.storageAccountName}"`,
    () => arm.deleteStorageAccount(ids.storage),
    log,
  );
  return { scope: 'resources', started: [server, storage] };
}

/**
 * Follows each accepted delete until Azure has finished it, and logs the end. Throws the first failure, after the
 * other deletes have ended too.
 */
export async function followDeletion(started: readonly StartedDeletion[], deps: FollowDeps): Promise<void> {
  const results = await Promise.allSettled(started.map((deletion) => followOne(deletion, deps)));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) {
    throw failed.reason;
  }
}

async function start(
  what: string,
  request: () => Promise<ArmOperation>,
  log: Pick<Logger, 'info'>,
): Promise<StartedDeletion> {
  const operation = await request();
  log.info(
    operation.status === 202 || operation.status === 201
      ? `Azure accepted deleting ${what} (HTTP ${operation.status}).`
      : `Azure deleted ${what} (HTTP ${operation.status}).`,
  );
  return { what, operation };
}

async function followOne({ what, operation }: StartedDeletion, deps: FollowDeps): Promise<void> {
  if (operation.poll === undefined) {
    if (operation.status === 202 || operation.status === 201) {
      deps.log.warn(`Azure gave no address to follow the deletion of ${what}. Check it in the Azure portal.`);
    }
    return;
  }
  const { pollMs = FOLLOW_POLL_MS, timeoutMs = FOLLOW_TIMEOUT_MS } = deps;
  const now = deps.now ?? Date.now;
  const begin = now();
  let failures = 0;
  for (;;) {
    try {
      if (await deps.arm.operationDone(operation)) {
        deps.log.info(`Azure finished deleting ${what} after ${elapsed(now() - begin)}.`);
        return;
      }
      failures = 0;
    } catch (error) {
      if (!isPassingPollFailure(error) || ++failures > TOLERATED_POLL_FAILURES) {
        throw new AantjeError(
          isAantjeError(error) ? error.code : 'CONNECTION_FAILED',
          `Azure did not delete ${what}: ${userMessageOf(error)}`,
          { cause: error },
        );
      }
      deps.log.warn(`No answer how the deletion of ${what} goes on (${error.userMessage}); asking again.`);
    }
    if (now() - begin >= timeoutMs) {
      throw new AantjeError(
        'TIMEOUT',
        `Azure has not finished deleting ${what} after ${elapsed(timeoutMs)}. Check it in the Azure portal.`,
      );
    }
    // As while waiting for a deployment: each failed poll in a row waits twice as long.
    await deps.sleep(pollMs * 2 ** failures);
  }
}

const resourceLabel = ({ id, type }: { id: string; type: string }): string =>
  `${type} "${id.slice(id.lastIndexOf('/') + 1)}"`;
