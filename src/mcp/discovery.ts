// How the stdio bridge finds the MCP server of its window: every window of the editor (one extension host each) writes
// a small file with its URL, token and workspace folders into a folder of aantje's global storage, readable only by
// the user; the bridge picks the window whose workspace holds its working directory.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

/** The folder of the window files, below the folder of the bridge. */
export const WINDOWS_FOLDER = 'windows';
/** The path that answers whether the server of a window still runs, and in which process; it needs the token. */
export const ALIVE_PATH = '/alive';
/** The header with the process of the extension host in the answer of `ALIVE_PATH`. */
export const PID_HEADER = 'x-aantje-pid';

export interface WindowEntry {
  /** The process of the extension host; a file of a process that has ended is ignored. */
  readonly pid: number;
  readonly url: string;
  readonly token: string;
  /** The workspace folders of the window, as paths of the machine the extension host runs on. */
  readonly folders: readonly string[];
}

/** The servers of aantje listen on this machine only: a file that names another address is no window's. */
const isLocalUrl = (url: unknown): boolean => {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
};

const isEntry = (value: unknown): value is WindowEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    Number.isInteger(entry.pid) &&
    isLocalUrl(entry.url) &&
    typeof entry.token === 'string' &&
    Array.isArray(entry.folders) &&
    entry.folders.every((folder) => typeof folder === 'string')
  );
};

/** Writes the file of this window atomically, readable and writable only by the user; returns its path. */
export async function writeWindowEntry(folder: string, entry: WindowEntry): Promise<string> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, `${entry.pid}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 });
  await rename(temporary, file);
  return file;
}

export async function removeWindowEntry(file: string): Promise<void> {
  await rm(file, { force: true });
}

/** Whether a process runs; `process.kill(pid, 0)` sends no signal. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process runs under another user; it is alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The entries of the windows whose extension host still runs; unreadable files are skipped. */
export async function readWindowEntries(
  folder: string,
  alive: (pid: number) => boolean,
): Promise<WindowEntry[]> {
  const names = await readdir(folder).catch(() => [] as string[]);
  const entries = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        try {
          const value: unknown = JSON.parse(await readFile(join(folder, name), 'utf8'));
          return isEntry(value) && alive(value.pid) ? value : undefined;
        } catch {
          return undefined;
        }
      }),
  );
  return entries.filter((entry): entry is WindowEntry => entry !== undefined);
}

/**
 * What the server of a window file answers: `ours` when it runs in the process of the file, `other` when nothing
 * listens there or something else answers (another program, a later server with another token), `silent` when it does
 * not answer in time. A file whose process has ended keeps its PID, which a new process can get, so only the server
 * itself tells whether a file is current.
 */
export async function probeWindow(
  entry: WindowEntry,
  timeoutMs: number,
): Promise<'ours' | 'other' | 'silent'> {
  try {
    const response = await fetch(new URL(ALIVE_PATH, entry.url), {
      headers: { Authorization: `Bearer ${entry.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.status === 204 && response.headers.get(PID_HEADER) === String(entry.pid)
      ? 'ours'
      : 'other';
  } catch (error) {
    return (error as Error).name === 'TimeoutError' ? 'silent' : 'other';
  }
}

/** The entries whose server answers as the server of the file. */
export async function answeringEntries(
  entries: readonly WindowEntry[],
  timeoutMs: number,
): Promise<WindowEntry[]> {
  const answers = await Promise.all(entries.map((entry) => probeWindow(entry, timeoutMs)));
  return entries.filter((_, index) => answers[index] === 'ours');
}

/**
 * The window files of the folder that are left over: unreadable, of a process that has ended, or of a server that
 * does not answer as theirs any more (a hard stop leaves the file). A server that is only slow keeps its file. `own`
 * is the file of this window, which is never left over.
 */
export async function leftoverWindowFiles(
  folder: string,
  own: string,
  alive: (pid: number) => boolean,
  timeoutMs: number,
): Promise<string[]> {
  const names = await readdir(folder).catch(() => [] as string[]);
  const files = names.filter((name) => name.endsWith('.json')).map((name) => join(folder, name));
  const leftover = await Promise.all(
    files
      .filter((file) => file !== own)
      .map(async (file) => {
        let value: unknown;
        try {
          value = JSON.parse(await readFile(file, 'utf8'));
        } catch {
          return file;
        }
        if (!isEntry(value) || !alive(value.pid)) return file;
        return (await probeWindow(value, timeoutMs)) === 'other' ? file : undefined;
      }),
  );
  return leftover.filter((file): file is string => file !== undefined);
}

/** Whether `path` is `folder` or lies below it; on Windows without regard to case. */
export function isWithin(folder: string, path: string, ignoreCase: boolean): boolean {
  const fold = (text: string): string => (ignoreCase ? text.toLowerCase() : text);
  const rest = relative(fold(folder), fold(path));
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest));
}

/**
 * The window of the working directory: the one whose workspace holds it (the deepest folder wins when workspaces
 * nest), else the only window there is. Otherwise a message that says why none was chosen.
 */
export function pickWindow(
  entries: readonly WindowEntry[],
  cwd: string,
  ignoreCase: boolean,
): WindowEntry | string {
  if (entries.length === 0) {
    return 'aantje is not running in VS Code, or its MCP server is switched off (aantje.mcp.enabled).';
  }
  // How deep the working directory lies in the window's workspace: the length of the longest folder that holds it.
  const depthOf = (entry: WindowEntry): number =>
    Math.max(
      -1,
      ...entry.folders.filter((folder) => isWithin(folder, cwd, ignoreCase)).map((folder) => folder.length),
    );
  const ranked = entries.map((entry) => ({ entry, depth: depthOf(entry) })).filter(({ depth }) => depth >= 0);
  const best = Math.max(-1, ...ranked.map(({ depth }) => depth));
  const matching = ranked.filter(({ depth }) => depth === best).map(({ entry }) => entry);
  if (matching.length === 1 && matching[0]) return matching[0];
  if (matching.length === 0 && entries.length === 1 && entries[0]) return entries[0];
  return matching.length > 1
    ? `${matching.length} VS Code windows have this folder open; close all but one, or start Claude Code in a folder of one window only.`
    : `No VS Code window with aantje has ${cwd} open; start Claude Code in a folder of the workspace.`;
}
