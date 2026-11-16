// What the catalog tools of the MCP server read from: a connection by its name, the reader that the explorer holds
// for it and the snapshot that the explorer shows. A tool never connects. Free of the VS Code API.
import { foldIdentifier } from '../catalog/ddl';
import type { CatalogReader, SchemaInfo, SnapshotId } from '../catalog/model';
import type { ConnectionProfile } from '../connections/profile';

/** An error whose message is meant for the client of the tool; any other error is reported without its text. */
export class ToolError extends Error {}

export interface CatalogSource {
  readonly profiles: () => readonly ConnectionProfile[];
  /**
   * The reader and the snapshot that the explorer shows, and whether it follows the newest snapshot (`newest`);
   * undefined while the connection is not connected.
   */
  readonly catalog: (
    connectionId: string,
  ) =>
    { readonly reader: CatalogReader; readonly snapshot: SnapshotId; readonly newest?: boolean } | undefined;
}

export interface OpenCatalog {
  readonly profile: ConnectionProfile;
  readonly reader: CatalogReader;
  readonly snapshot: SnapshotId;
}

/**
 * The items that `name` means as an identifier: those of the same spelling, else those that DuckDB takes for it
 * (identifiers ignore the case of A to Z).
 */
export function named<T extends { readonly name: string }>(items: readonly T[], name: string): T[] {
  const same = items.filter((item) => item.name === name);
  if (same.length > 0) return same;
  const folded = foldIdentifier(name);
  return items.filter((item) => foldIdentifier(item.name) === folded);
}

/** The connection of that name: the same spelling first, else ignoring case; throws when there is none. */
export function profileNamed(source: Pick<CatalogSource, 'profiles'>, name: string): ConnectionProfile {
  const profiles = source.profiles();
  const same = profiles.filter((profile) => profile.name === name);
  const found = same.length > 0 ? same : named(profiles, name);
  const [profile] = found;
  if (!profile || found.length > 1) {
    throw new ToolError(`aantje has no connection named "${name}". list_connections names them.`);
  }
  return profile;
}

/**
 * The connection of that name with its reader and the snapshot to read: the one pinned in the explorer, or, while the
 * explorer follows the newest snapshot, the newest one that the reader sees now, not the one of the last refresh.
 * Throws when there is no such connection or when it is not connected.
 */
export async function openCatalog(source: CatalogSource, name: string): Promise<OpenCatalog> {
  const profile = profileNamed(source, name);
  const catalog = source.catalog(profile.id);
  if (!catalog) {
    throw new ToolError(
      `The connection "${profile.name}" is not connected. Connect it in the aantje explorer first; the tools never connect.`,
    );
  }
  const { reader } = catalog;
  const snapshot = catalog.newest === true ? (await reader.info()).latestSnapshot : catalog.snapshot;
  return { profile, reader, snapshot };
}

/** The schema of that name at the snapshot; throws when there is none or when the name is ambiguous. */
export async function schemaOf(catalog: OpenCatalog, name: string): Promise<SchemaInfo> {
  const found = named(await catalog.reader.schemas(catalog.snapshot), name);
  const [schema] = found;
  if (!schema) {
    throw new ToolError(
      `The connection "${catalog.profile.name}" has no schema "${name}" at snapshot ${catalog.snapshot}.`,
    );
  }
  if (found.length > 1) {
    throw new ToolError(
      `Several schemas are named "${name}" apart from upper and lower case: ${found.map((item) => item.name).join(', ')}. Use the exact spelling.`,
    );
  }
  return schema;
}
