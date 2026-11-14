import type { SecretsPort } from '../connections/ports';
import { STORED_VALUE_NAMES, storageTarget } from './config';
import type { StorageConfig, StorageValues, StoredValueName } from './config';

/** The VS Code secret storage key of a connection's storage secrets. */
export function storageSecretKey(connectionId: string): string {
  return `aantje.connection.${connectionId}.storage`;
}

/**
 * The sign-in secrets of a connection's storage (keys, session token, connection string, account key, SAS, client
 * secret) in one secret storage entry, `{ target, values }`. The entry is bound to the service it was entered for
 * (`storageTarget`), as a password is bound to its server: after the endpoint, the account or the sign-in changed, the
 * values count as not stored and are never sent anywhere else. Every value read or written is registered for log
 * masking.
 */
export class StorageSecretStore {
  constructor(
    private readonly secrets: SecretsPort,
    private readonly registerSecret: (value: string) => void = () => undefined,
  ) {}

  /** The stored values, but only when they were entered for this storage; undefined when there are none. */
  async get(connectionId: string, config: StorageConfig): Promise<StorageValues | undefined> {
    const raw = await this.secrets.get(storageSecretKey(connectionId));
    const values = raw === undefined ? undefined : boundValues(raw, config);
    this.register(values);
    return values;
  }

  /** Replaces the stored values. An empty set deletes the entry. */
  async set(connectionId: string, config: StorageConfig, values: StorageValues): Promise<void> {
    const kept = keptValues(values);
    if (Object.keys(kept).length === 0) {
      await this.delete(connectionId);
      return;
    }
    this.register(kept);
    await this.secrets.set(
      storageSecretKey(connectionId),
      JSON.stringify({ target: storageTarget(config), values: kept }),
    );
  }

  async delete(connectionId: string): Promise<void> {
    await this.secrets.delete(storageSecretKey(connectionId));
  }

  /**
   * Deletes the entry when it no longer belongs to the storage (the endpoint, account or sign-in changed) or when the
   * profile has no storage any more; keeps one that still matches.
   */
  async discardOrphan(connectionId: string, config: StorageConfig | undefined): Promise<void> {
    const raw = await this.secrets.get(storageSecretKey(connectionId));
    if (raw !== undefined && (config === undefined || boundValues(raw, config) === undefined)) {
      await this.delete(connectionId);
    }
  }

  private register(values: StorageValues | undefined): void {
    for (const value of Object.values(values ?? {})) {
      if (value) {
        this.registerSecret(value);
      }
    }
  }
}

function keptValues(values: StorageValues): StorageValues {
  const kept: Partial<Record<StoredValueName, string>> = {};
  for (const name of STORED_VALUE_NAMES) {
    const value = values[name];
    if (typeof value === 'string' && value !== '') {
      kept[name] = value;
    }
  }
  return kept;
}

/** The values of a stored entry when it was stored for `config`'s target; otherwise undefined. */
export function boundValues(raw: string, config: StorageConfig): StorageValues | undefined {
  try {
    const entry = JSON.parse(raw) as { target?: unknown; values?: unknown };
    if (typeof entry.target !== 'string' || entry.target !== storageTarget(config)) {
      return undefined;
    }
    if (typeof entry.values !== 'object' || entry.values === null || Array.isArray(entry.values)) {
      return undefined;
    }
    return keptValues(entry.values);
  } catch {
    // Not the bound form (hand-edited, or from another build): treated as absent and never sent.
    return undefined;
  }
}
