import { isObject } from '../guards';
import type { KeyValueStore } from '../azure/registry';
import type { ConnectionNotice } from '../tree/refs';

/** What a later delete or Allow My IP needs of a lake that aantje created; kept next to the connection. */
export interface CreatedAwsLake {
  readonly account: string;
  readonly region: string;
  readonly awsProfile?: string;
  readonly stackId: string;
  readonly stackName: string;
  readonly bucket: string;
}

/** A delete of the lake that started and did not finish: when it started, and the final snapshot it took. */
export interface UnfinishedDelete {
  /** ISO time of the last start. */
  readonly since: string;
  readonly snapshot?: string;
}

const KEY = 'aantje.awsLakes';
const UNATTACHED_KEY = 'aantje.unattachedAwsLakes';
const DELETING_KEY = 'aantje.deletingAwsLakes';

/**
 * What aantje created in AWS, by connection id. Only these lakes will offer Delete: a connection that was merely
 * imported says nothing about who owns the stack. Also the lakes that were saved but never attached.
 */
export class AwsLakeRegistry {
  private readonly listeners = new Set<(connectionId: string) => void>();

  constructor(private readonly store: KeyValueStore) {}

  get(connectionId: string): CreatedAwsLake | undefined {
    const entry = this.all(KEY)[connectionId];
    return isCreatedAwsLake(entry) ? entry : undefined;
  }

  async set(connectionId: string, lake: CreatedAwsLake): Promise<void> {
    await this.store.update(KEY, { ...this.all(KEY), [connectionId]: lake });
  }

  async remove(connectionId: string): Promise<void> {
    const { [connectionId]: _removed, ...rest } = this.all(KEY);
    await this.store.update(KEY, rest);
    await this.markAttached(connectionId);
    const { [connectionId]: _deleting, ...others } = this.all(DELETING_KEY);
    await this.store.update(DELETING_KEY, others);
    this.changed(connectionId);
  }

  /** Set when the user confirmed Delete AWS DuckLake; `remove` clears it when the delete finished. */
  async markDeleting(connectionId: string, since: Date): Promise<void> {
    // A snapshot of an earlier run stays: that run deleted the database with it.
    const earlier = this.unfinishedDelete(connectionId);
    await this.setDeleting(connectionId, { ...earlier, since: since.toISOString() });
  }

  /** The final snapshot that RDS takes, noted as soon as the database is being deleted with it. */
  async noteSnapshot(connectionId: string, snapshot: string): Promise<void> {
    const deleting = this.unfinishedDelete(connectionId);
    if (deleting) await this.setDeleting(connectionId, { ...deleting, snapshot });
  }

  unfinishedDelete(connectionId: string): UnfinishedDelete | undefined {
    const entry = this.all(DELETING_KEY)[connectionId];
    if (!isObject(entry) || typeof entry.since !== 'string') return undefined;
    return typeof entry.snapshot === 'string'
      ? { since: entry.since, snapshot: entry.snapshot }
      : { since: entry.since };
  }

  /** Tells when a delete of a lake started, took its snapshot or ended. */
  onDidChange(listener: (connectionId: string) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  /** Set before the first attach, which makes DuckLake create its tables, and cleared when it has succeeded. */
  async markUnattached(connectionId: string, dataPath: string): Promise<void> {
    await this.store.update(UNATTACHED_KEY, { ...this.all(UNATTACHED_KEY), [connectionId]: dataPath });
  }

  async markAttached(connectionId: string): Promise<void> {
    const { [connectionId]: _removed, ...rest } = this.all(UNATTACHED_KEY);
    await this.store.update(UNATTACHED_KEY, rest);
  }

  unattached(): { connectionId: string; dataPath: string }[] {
    return Object.entries(this.all(UNATTACHED_KEY)).flatMap(([connectionId, dataPath]) =>
      typeof dataPath === 'string' ? [{ connectionId, dataPath }] : [],
    );
  }

  private async setDeleting(connectionId: string, deleting: UnfinishedDelete): Promise<void> {
    await this.store.update(DELETING_KEY, { ...this.all(DELETING_KEY), [connectionId]: deleting });
    this.changed(connectionId);
  }

  private changed(connectionId: string): void {
    for (const listener of [...this.listeners]) listener(connectionId);
  }

  private all(key: string): Record<string, unknown> {
    const value = this.store.get(key);
    return isObject(value) ? value : {};
  }
}

/** What to tell the user at start about a lake that was saved as a connection but never attached. */
export function unattachedAwsNotice(connectionName: string): string {
  return `The AWS DuckLake "${connectionName}" was saved as a connection, but its first attach did not finish, so its catalog may still be empty. Attach it now? The lake itself exists in AWS and keeps costing money until you delete it.`;
}

/** What the explorer shows on a lake whose delete did not finish: a label next to the name, and Markdown for the tooltip. */
export function unfinishedDeleteNotice(deleting: UnfinishedDelete): ConnectionNotice {
  const since = new Date(deleting.since).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return {
    label: 'delete unfinished',
    tooltip: `**Delete AWS DuckLake did not finish** (started ${since}). The database may be gone already, so connecting fails. Run Delete AWS DuckLake... again: it goes on where it stopped.`,
  };
}

function isCreatedAwsLake(value: unknown): value is CreatedAwsLake {
  return (
    isObject(value) &&
    ['account', 'region', 'stackId', 'stackName', 'bucket'].every((key) => typeof value[key] === 'string') &&
    (value.awsProfile === undefined || typeof value.awsProfile === 'string')
  );
}
