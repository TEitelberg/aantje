import { storageSecretStatement } from '../storage/statements';
import { postgresSecretStatement } from './attach';
import type { DataAccess } from './types';

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

/**
 * The jobs that replace the tokens of a session: the storage token of an Azure or OneLake storage, the password of an
 * Entra login.
 * Each new token joins `secrets` before it is used, so that an error quoting it is masked; the old ones stay there,
 * because a statement that started with one may still report it.
 */
export function tokenRenewals(
  { storage, profile, renewPassword }: DataAccess,
  secrets: string[],
  run: (sql: string) => Promise<unknown>,
): (() => Promise<void>)[] {
  const renewals: (() => Promise<void>)[] = [];
  if (storage?.refresh) {
    const { refresh } = storage;
    renewals.push(async () => {
      const accessToken = await refresh();
      secrets.push(accessToken);
      const renewed = storageSecretStatement({ ...storage, values: { ...storage.values, accessToken } });
      if (renewed) await run(renewed);
    });
  }
  if (renewPassword && profile.kind === 'postgres') {
    renewals.push(async () => {
      const token = await renewPassword();
      secrets.push(token);
      await run(postgresSecretStatement(profile, token));
    });
  }
  return renewals;
}
