import { isObject } from '../guards';
import type { CreatedLake } from './create-lake';

/** The part of the VS Code `Memento` the registry uses. */
export interface KeyValueStore {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

const KEY = 'aantje.azureLakes';

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
  }

  private all(): Record<string, unknown> {
    const value = this.store.get(KEY);
    return isObject(value) ? value : {};
  }
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
