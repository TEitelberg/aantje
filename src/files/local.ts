import type { Dirent } from 'node:fs';
import { opendir, realpath, stat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { AantjeError, isAantjeError } from '../errors';
import type { RawEntry, RawLevel } from './http';
import { shownText } from './http';

// One level of a folder on the disk. A local root lists only below itself: the folder and every link in it are
// resolved, and what resolves outside the root is not listed (a link to `/etc` is no file of the root).

// Stats of one level run in groups, so that a large folder does not open thousands of handles at once.
const STAT_GROUP = 64;

/** Whether `path` (resolved) is `root` (resolved) or below it. */
function isWithin(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest));
}

function failure(error: unknown): AantjeError {
  if (isAantjeError(error)) return error;
  const { code, message } = error as NodeJS.ErrnoException;
  return new AantjeError(
    code === 'EACCES' || code === 'EPERM' ? 'AUTH_FAILED' : 'FILE_NOT_FOUND',
    shownText(`The folder cannot be listed: ${message || String(code)}`),
    { cause: error },
  );
}

async function entryOf(rootReal: string, directory: string, entry: Dirent): Promise<RawEntry | undefined> {
  const path = join(directory, entry.name);
  try {
    if (entry.isSymbolicLink() && !isWithin(rootReal, await realpath(path))) {
      return undefined;
    }
    const info = await stat(path);
    if (info.isDirectory()) return { key: entry.name, folder: true, modified: info.mtimeMs };
    if (info.isFile()) return { key: entry.name, folder: false, size: info.size, modified: info.mtimeMs };
    return undefined;
  } catch {
    // A link to nowhere, or an entry removed while the level was read.
    return undefined;
  }
}

/**
 * The folders and files directly in `directory`, which must lie in `root`; at most `ceiling`. Keys are the names. A
 * folder that resolves outside the root is refused.
 */
export async function listLocalLevel(root: string, directory: string, ceiling: number): Promise<RawLevel> {
  try {
    const [rootReal, directoryReal] = await Promise.all([realpath(root), realpath(directory)]);
    if (!isWithin(rootReal, directoryReal)) {
      throw new AantjeError('FILE_NOT_FOUND', 'This folder lies outside its root and is not listed.');
    }
    const found: Dirent[] = [];
    let cut = false;
    for await (const entry of await opendir(directory)) {
      if (found.length >= ceiling) {
        cut = true;
        break;
      }
      found.push(entry);
    }
    const entries: RawEntry[] = [];
    for (let start = 0; start < found.length; start += STAT_GROUP) {
      const group = await Promise.all(
        found.slice(start, start + STAT_GROUP).map((entry) => entryOf(rootReal, directory, entry)),
      );
      entries.push(...group.filter((entry): entry is RawEntry => entry !== undefined));
    }
    return { entries, cut };
  } catch (error) {
    throw failure(error);
  }
}
