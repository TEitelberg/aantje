import type { CatalogReader, SnapshotId } from '../catalog/model';
import type { SchemaComparison } from '../compare';
import type { TableRef } from '../data/types';
import type { ChangeChoice, TimeTravelUi } from '../time-travel';

/** What the actions of the reports do in VS Code; the plan says what, the port does it. */
export interface ReportPort {
  readonly connectionId: string;
  readonly connectionName: string;
  readonly ui: TimeTravelUi;
  /** Undefined when the connection is closed. */
  reader(): CatalogReader | undefined;
  /** Shows the catalog at the snapshot, or follows the latest one. */
  showCatalog(snapshot: SnapshotId | 'latest'): void;
  showsLatest(): boolean;
  showChanges(choice: ChangeChoice): Promise<void>;
  showSchema(comparison: SchemaComparison): Promise<void>;
  showReport(markdown: string): Promise<void>;
  showRows(table: TableRef, snapshot: SnapshotId): Promise<void>;
  createNotebook(table: TableRef, snapshot: SnapshotId): Promise<void>;
  /** Opens an untitled SQL document of the connection; nothing runs. */
  openSql(text: string): Promise<void>;
}
