import type { Logger } from './log';

/** How long `deactivate` waits for disposals; VS Code stops waiting after a few seconds anyway. */
const SHUTDOWN_TIMEOUT_MS = 3000;

/**
 * Runs all disposals at once and waits at most `timeoutMs`: one that never finishes (an uninterruptible session)
 * must not block the others or the extension host shutdown. A failed or overrunning disposal is logged.
 */
export async function disposeAll(
  disposals: Readonly<Record<string, () => Promise<void> | void>>,
  logger: Logger,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  const pending = new Set(Object.keys(disposals));
  const settled = Promise.all(
    Object.entries(disposals).map(async ([name, dispose]) => {
      try {
        await dispose();
      } catch (error) {
        logger.error(`Closing the ${name} failed.`, error);
      } finally {
        pending.delete(name);
      }
    }),
  );
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([settled, deadline]);
  } finally {
    clearTimeout(timer);
  }
  if (pending.size > 0) {
    logger.warn(`Gave up waiting for the ${[...pending].join(', ')} to close after ${timeoutMs} ms.`);
  }
}
