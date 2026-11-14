import { isObject } from '../guards';
import type { CreatedLake } from './create-lake';

/** The part of the VS Code `Memento` the registry uses. */
export interface KeyValueStore {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

const KEY = 'aantje.azureLakes';
const UNATTACHED_KEY = 'aantje.unattachedAzureLakes';

/**
 * What aantje created in Azure, by connection id. Only these lakes offer Delete: a connection that was merely imported
 * says nothing about who owns the resources.
 */
export class LakeRegistry {
  constructor(private readonly store: KeyValueStore) {}

  get(connectionId: string): CreatedLake | undefined {
    const entry = this.all()[connectionId];
    return isCreatedLake(entry) ? entry : undefined;
  }

  async set(connectionId: string, lake: CreatedLake): Promise<void> {
    await this.store.update(KEY, { ...this.all(), [connectionId]: lake });
  }

  async remove(connectionId: string): Promise<void> {
    const { [connectionId]: _removed, ...rest } = this.all();
    await this.store.update(KEY, rest);
    await this.markAttached(connectionId);
  }

  /**
   * A new lake is saved as a connection before its first attach, which makes DuckLake create its tables. The mark stays
   * until that attach has succeeded, so an editor that closed in between, or a failed attach, can be found at the next
   * start.
   */
  async markUnattached(connectionId: string, dataPath: string): Promise<void> {
    await this.store.update(UNATTACHED_KEY, { ...this.unattachedAll(), [connectionId]: dataPath });
  }

  async markAttached(connectionId: string): Promise<void> {
    const { [connectionId]: _removed, ...rest } = this.unattachedAll();
    await this.store.update(UNATTACHED_KEY, rest);
  }

  /** The connections whose lake was saved but never attached, with the data path to attach it with. */
  unattached(): { connectionId: string; dataPath: string }[] {
    return Object.entries(this.unattachedAll()).flatMap(([connectionId, dataPath]) =>
      typeof dataPath === 'string' ? [{ connectionId, dataPath }] : [],
    );
  }

  private all(): Record<string, unknown> {
    const value = this.store.get(KEY);
    return isObject(value) ? value : {};
  }

  private unattachedAll(): Record<string, unknown> {
    const value = this.store.get(UNATTACHED_KEY);
    return isObject(value) ? value : {};
  }
}

/** What to tell the user at start about a lake that was saved as a connection but never attached. */
export function unattachedNotice(connectionName: string): string {
  return `The Azure DuckLake "${connectionName}" was saved as a connection, but its first attach did not finish, so its catalog may still be empty. Attach it now? The lake itself exists in Azure and keeps costing money until you delete it.`;
}

function isCreatedLake(value: unknown): value is CreatedLake {
  return (
    isObject(value) &&
    typeof value.subscriptionId === 'string' &&
    typeof value.resourceGroup === 'string' &&
    typeof value.createdResourceGroup === 'boolean' &&
    typeof value.serverName === 'string' &&
    typeof value.storageAccountName === 'string'
  );
}
