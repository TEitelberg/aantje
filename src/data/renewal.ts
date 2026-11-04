// An Entra token lives for at least 60 minutes and the sign-in hands out one that has more than a few minutes left.
/** How often a long session replaces the tokens it holds; there is room for a few missed rounds. */
const RENEWAL_INTERVAL_MS = 10 * 60_000;

/**
 * Runs every job once per interval. A failing job is reported and does not stop the others or the next round, so the
 * session goes on with the old token until it runs out. The timer does not keep the process alive.
 */
export function startRenewal(
  jobs: readonly (() => Promise<void>)[],
  onError: (error: unknown) => void,
  intervalMs = RENEWAL_INTERVAL_MS,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    for (const job of jobs) {
      void job().catch(onError);
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
