import { randomUUID } from 'node:crypto';
import { open, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * The file that a run is about to write. `discard` removes what the run left there after a failure or a cancel, but only
 * when there was no file before: a file that the user had must not go. A writer that replaces an existing file keeps the
 * old one when it fails (DuckDB's COPY writes it through a temporary file and removes a partial new file itself).
 */
export interface PendingFile {
  readonly path: string;
  discard(): Promise<void>;
}

// An engine that was released at a cancel may still hold the file open for a moment; Windows refuses to delete it then.
const ATTEMPTS = 10;
const RETRY_MS = 100;

/** Notes whether the file exists now, before the run writes it. */
export async function pendingFile(path: string): Promise<PendingFile> {
  const existed = await stat(path).then(
    () => true,
    () => false,
  );
  return {
    path,
    discard: async () => {
      if (existed) return;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
          await rm(path, { force: true });
          return;
        } catch {
          // Best effort: a file that stays locked is left; the run already reported its failure or cancel.
          if (attempt < ATTEMPTS) await sleep(RETRY_MS * attempt);
        }
      }
    },
  };
}

/** Runs `write`, which writes the file; when it throws, also at a cancel, the partial file goes (see `PendingFile`). */
export async function writingFile<T>(path: string, write: () => Promise<T>): Promise<T> {
  const file = await pendingFile(path);
  try {
    return await write();
  } catch (error) {
    await file.discard();
    throw error;
  }
}

/** Adds text to a file in UTF-8; the next call waits for the one before. */
export type Append = (text: string) => Promise<void>;

/**
 * Writes a text file through `write`, which hands its parts to `append` one after the other, so the whole text is never
 * in memory. The parts go to a temporary file next to `path`, which replaces `path` only when `write` has ended: a failure
 * or a cancel leaves no partial file and keeps a file that was there. A part appended after a failure goes nowhere.
 */
export async function replacingFile<T>(path: string, write: (append: Append) => Promise<T>): Promise<T> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID().slice(0, 8)}.tmp`);
  return writingFile(temporary, async () => {
    const handle = await open(temporary, 'wx');
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => (closing ??= handle.close());
    try {
      const result = await write(async (text) => {
        if (closing) throw new Error('The file is closed.');
        await handle.write(text, null, 'utf8');
      });
      await close();
      await rename(temporary, path);
      return result;
    } finally {
      // Closed before `writingFile` removes the temporary file, which Windows refuses while it is open.
      await close().catch(() => undefined);
    }
  });
}
