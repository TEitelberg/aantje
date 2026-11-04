import type { SnapshotId } from '../catalog/model';
import type { ConnectionProfile } from '../connections/profile';
import type { Logger } from '../log';

export const PREVIEW_LIMIT = 1000;

/** Plain (unquoted) names. */
export interface TableRef {
  readonly schema: string;
  readonly table: string;
}

export type GridValue = string | number | boolean | null;

export interface GridColumn {
  readonly name: string;
  /** DuckDB type name, e.g. `DECIMAL(10,2)`. */
  readonly type: string;
  readonly kind: 'number' | 'boolean' | 'text' | 'nested';
}

/** Kind of a change grid row; an update is the pair `update-before`, directly followed by `update-after`. */
export type RowKind = 'insert' | 'delete' | 'update-before' | 'update-after';

/** A change grid starts with `snapshot_id`, `rowid` and `change_type`, then the table's columns. */
export const CHANGE_COLUMNS = 3;

export interface GridData {
  readonly table: TableRef;
  readonly columns: readonly GridColumn[];
  readonly rows: readonly (readonly GridValue[])[];
  readonly limit: number;
  /** The table has more rows than `limit`. */
  readonly truncated: boolean;
  readonly elapsedMs: number;
  /** Changes only: the kind of each row, in the order of `rows`. */
  readonly rowKinds?: readonly RowKind[];
  /** Changes only: the line above the rows. */
  readonly summary?: string;
}

export interface S3Settings {
  /** `host:port` or `http(s)://host:port`; empty means the AWS default. */
  readonly endpoint?: string;
  readonly region?: string;
  readonly urlStyle?: 'path' | 'vhost';
}

export interface S3Credentials {
  readonly keyId: string;
  readonly secretKey: string;
}

/** Entra access to the storage account of an Azure lake: DuckDB's azure extension does not renew an access token. */
export interface AzureAccess {
  readonly accountName: string;
  readonly accessToken: string;
  /** A fresh token; a long session calls it before the old one runs out. */
  readonly refresh?: () => Promise<string>;
}

export interface DataAccess {
  readonly profile: ConnectionProfile;
  /** PostgreSQL password from the secret storage. */
  readonly password?: string;
  /** Entra login: `password` is a token, and this gets another one; a long session calls it before the old one runs out. */
  readonly renewPassword?: () => Promise<string>;
  /**
   * Whether the user has confirmed trust in this connection's views. When the relation actually read at the snapshot is
   * a view and this is not set, the guard refuses with `VIEW_UNTRUSTED` instead of binding the view's SQL; the command
   * layer then asks and retries. Decided from what is read, not from the tree node, so a table that is a view at an older
   * snapshot (or was turned into one) is covered too.
   */
  readonly viewsTrusted?: boolean;
  /** Undefined means the latest snapshot. */
  readonly snapshot?: SnapshotId;
  readonly s3: S3Settings;
  readonly s3Credentials?: S3Credentials;
  readonly azure?: AzureAccess;
  /** DuckDB `extension_directory`; undefined keeps the DuckDB default (extensions download on first use). */
  readonly extensionDirectory?: string;
  /** Limit of the attach and the query, in ms; undefined means none. Extension downloads do not count. */
  readonly timeoutMs?: number;
  /** Limit of installing and loading the extensions, in ms; undefined means 5 minutes. Test seam, not a setting. */
  readonly extensionTimeoutMs?: number;
  /** Where failures that cannot be reported to the caller go, e.g. an engine that does not close cleanly. */
  readonly log?: Pick<Logger, 'warn'>;
}

/** A column of a table or view as DuckDB resolves it. */
export interface RelationColumn {
  readonly name: string;
  /** DuckDB type name, e.g. `STRUCT(a INTEGER)`. */
  readonly type: string;
  readonly nullable: boolean;
}
