import type { Logger } from '../log';
import { userMessageOf } from '../errors';
import { inlineCode, markdownText } from '../markdown';
import type { CatalogReader } from '../catalog/model';
import { checkCopy } from './read';
import type { IcebergCheck } from './read';
import type { IcebergCopies, IcebergCopyRecord } from './records';
import { summaryOf, tableLine } from './status';
import type { IcebergTargetStore } from './store';
import type { IcebergTarget } from './target';

/** One row of the tree: a target that a connection was copied to. */
export interface IcebergRow {
  readonly targetId: string;
  readonly name: string;
  /** `checking`: no result yet. Green only when every copied table is in sync; everything else is red. */
  readonly color: 'green' | 'red' | 'none';
  readonly description: string;
  /** Markdown: every text from the catalogs is escaped. */
  readonly tooltip: string;
}

type Result =
  | { readonly state: 'checking' }
  | { readonly state: 'done'; readonly check: IcebergCheck }
  | { readonly state: 'failed'; readonly message: string };

const keyOf = (connectionId: string, targetId: string): string => JSON.stringify([connectionId, targetId]);

/**
 * Keeps the last check of each copy of a connection for the tree: a copy is checked when the connection opens or is
 * refreshed, and after a copy. The check reads the lake and asks the Iceberg catalog; it never writes.
 */
export class IcebergStatuses {
  private readonly results = new Map<string, Result>();
  /** The newest check started for each copy, and a counter of all of them. */
  private readonly runs = new Map<string, number>();
  private lastRun = 0;
  private readonly listeners = new Set<(connectionId: string) => void>();

  constructor(
    private readonly deps: {
      readonly targets: Pick<IcebergTargetStore, 'list' | 'secret'>;
      readonly copies: Pick<IcebergCopies, 'list'>;
      readonly reader: (connectionId: string) => CatalogReader | undefined;
      readonly log: Pick<Logger, 'warn'>;
    },
  ) {}

  /** Tells when the rows of a connection changed. */
  onDidChange(listener: (connectionId: string) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** The targets that the connection was copied to, with what the last check said. */
  rows(connectionId: string): IcebergRow[] {
    return this.targetsOf(connectionId).map(({ target, records }) =>
      this.rowOf(connectionId, target, records),
    );
  }

  /** The line for the tooltip of a table that was copied; undefined for any other table. */
  tableLines(connectionId: string, schema: string, table: string): string[] {
    return this.targetsOf(connectionId).flatMap(({ target }) => {
      const result = this.results.get(keyOf(connectionId, target.id));
      if (result?.state !== 'done') return [];
      const status = result.check.status.tables.find(
        (entry) => entry.schema === schema && entry.table === table,
      );
      return status ? [tableLine(status, target.name)] : [];
    });
  }

  /** `Iceberg: 3 behind` for a synced table that the lake changed after its sync (the most of all targets). */
  tableHint(connectionId: string, schema: string, table: string): string | undefined {
    const behind = this.targetsOf(connectionId).flatMap(({ target }) => {
      const result = this.results.get(keyOf(connectionId, target.id));
      if (result?.state !== 'done') return [];
      const status = result.check.status.tables.find(
        (entry) => entry.schema === schema && entry.table === table,
      );
      return status?.problems.includes('lake-newer') ? [status.snapshotsBehind] : [];
    });
    return behind.length === 0 ? undefined : `Iceberg: ${Math.max(...behind)} behind`;
  }

  /** The last check of one copy, if any. */
  last(connectionId: string, targetId: string): IcebergCheck | undefined {
    const result = this.results.get(keyOf(connectionId, targetId));
    return result?.state === 'done' ? result.check : undefined;
  }

  /** Checks every copy of the connection again; a connection that is not open is left as it was. */
  async check(connectionId: string): Promise<void> {
    const reader = this.deps.reader(connectionId);
    if (!reader) return;
    const runs = this.targetsOf(connectionId).map(({ target, records }) => {
      const key = keyOf(connectionId, target.id);
      this.results.set(key, { state: 'checking' });
      return { target, records, key, run: this.begin(key) };
    });
    this.fire(connectionId);
    await Promise.all(
      runs.map(async ({ target, records, key, run }) => {
        try {
          const check = await checkCopy({
            reader,
            records,
            target,
            secret: await this.deps.targets.secret(target),
          });
          this.settle(key, run, { state: 'done', check });
        } catch (error) {
          this.deps.log.warn(`Checking the Iceberg sync "${target.name}" failed: ${userMessageOf(error)}`);
          this.settle(key, run, { state: 'failed', message: userMessageOf(error) });
        }
      }),
    );
    this.fire(connectionId);
  }

  /** Checks one copy now, for its report, and shows the result in the tree; undefined when it cannot be checked. */
  async checkOne(connectionId: string, targetId: string): Promise<IcebergCheck | undefined> {
    const reader = this.deps.reader(connectionId);
    const copy = this.targetsOf(connectionId).find(({ target }) => target.id === targetId);
    if (!reader || !copy) return undefined;
    const key = keyOf(connectionId, targetId);
    const run = this.begin(key);
    try {
      const check = await checkCopy({
        reader,
        records: copy.records,
        target: copy.target,
        secret: await this.deps.targets.secret(copy.target),
      });
      this.settle(key, run, { state: 'done', check });
      return check;
    } catch (error) {
      this.settle(key, run, { state: 'failed', message: userMessageOf(error) });
      throw error;
    } finally {
      this.fire(connectionId);
    }
  }

  /** Starts a check of a copy; the newest one started is the one whose result counts. */
  private begin(key: string): number {
    this.lastRun += 1;
    this.runs.set(key, this.lastRun);
    return this.lastRun;
  }

  /** Keeps the result of a check unless a newer check of the copy began meanwhile: an older one must not overwrite it. */
  private settle(key: string, run: number, result: Result): void {
    if (this.runs.get(key) === run) this.results.set(key, result);
  }

  private targetsOf(connectionId: string): { target: IcebergTarget; records: IcebergCopyRecord[] }[] {
    const records = this.deps.copies.list(connectionId);
    return this.deps.targets
      .list()
      .map((target) => ({ target, records: records.filter((record) => record.targetId === target.id) }))
      .filter(({ records: found }) => found.length > 0);
  }

  private rowOf(
    connectionId: string,
    target: IcebergTarget,
    records: readonly IcebergCopyRecord[],
  ): IcebergRow {
    const result = this.results.get(keyOf(connectionId, target.id));
    const name = `Iceberg · ${target.name}`;
    const copied = `Synced ${records.length} ${records.length === 1 ? 'table' : 'tables'} to ${inlineCode(target.warehouse)} at ${inlineCode(target.endpoint)}. Click for the report.`;
    if (result === undefined || result.state === 'checking') {
      return { targetId: target.id, name, color: 'none', description: 'checking...', tooltip: copied };
    }
    if (result.state === 'failed') {
      return {
        targetId: target.id,
        name,
        color: 'red',
        description: 'could not check',
        tooltip: `${copied}\n\n${markdownText(result.message)}`,
      };
    }
    const { status, newest, icebergError } = result.check;
    return {
      targetId: target.id,
      name,
      color: status.inSync ? 'green' : 'red',
      description: icebergError === undefined ? summaryOf(status, newest) : 'could not ask the catalog',
      tooltip: icebergError === undefined ? copied : `${copied}\n\n${markdownText(icebergError)}`,
    };
  }

  private fire(connectionId: string): void {
    for (const listener of this.listeners) listener(connectionId);
  }
}
