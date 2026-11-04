import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataAccess } from './types';

/**
 * Memory limit of an engine; DuckDB's 80%-of-RAM default could be taken by a view's query. Overflow spills to a
 * private temp directory.
 */
export const MEMORY_LIMIT = '2GiB';

/**
 * Options for a fresh in-memory DuckDB: no persistent secrets (they would reach the home directory), an own temp
 * directory and a memory limit. The directory is created here, readable by its owner only, because DuckDB would create
 * it with the mode of the umask (0755) and spill files that other users of the machine could read; remove it with
 * `removeTemporaryFiles`. `extra` adds engine options and exists for tests (for example `s3_endpoint`, to point the
 * default S3 endpoint at a local fake); the fixed options win over it, and nothing in the product passes it.
 */
export function instanceOptions(
  access: DataAccess,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> & { temp_directory: string } {
  const temp_directory = join(tmpdir(), `aantje-duckdb-${randomUUID()}`);
  try {
    mkdirSync(temp_directory, { mode: 0o700 });
  } catch {
    // DuckDB then creates the directory itself on the first spill, or fails with its own message.
  }
  return {
    ...extra,
    allow_persistent_secrets: 'false',
    temp_directory,
    memory_limit: MEMORY_LIMIT,
    ...(access.extensionDirectory ? { extension_directory: access.extensionDirectory } : {}),
  };
}

/** Best effort; a locked file is left for the operating system's temp cleanup. */
export function removeTemporaryFiles(options: { readonly temp_directory: string }): void {
  try {
    rmSync(options.temp_directory, { recursive: true, force: true });
  } catch {
    // Left for the OS.
  }
}
