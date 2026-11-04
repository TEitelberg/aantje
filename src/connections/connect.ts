import type { OpenedCatalog } from '../catalog/open';
import { isAantjeError } from '../errors';
import { usesSecret } from './profile';
import type { ConnectionProfile } from './profile';
import type { ConnectionStore } from './store';

export interface ConnectDeps {
  readonly store: Pick<ConnectionStore, 'password' | 'registerPassword' | 'update'>;
  /** The token that is the password of an Entra login (`azureAuth: "entra"`). */
  entraToken?: (profile: ConnectionProfile) => Promise<string>;
  open(profile: ConnectionProfile, password: string | undefined): Promise<OpenedCatalog>;
  /** Asks for the password; `previousRejected` means a stored one was refused. Undefined or empty means cancelled. */
  askPassword(profile: ConnectionProfile, previousRejected: boolean): Promise<string | undefined>;
}

/**
 * Opens a profile's catalog; a PostgreSQL or Quack profile asks for its password or token once, after `AUTH_FAILED`,
 * and stores it only after it worked.
 */
export async function openWithPassword(
  profile: ConnectionProfile,
  deps: ConnectDeps,
): Promise<OpenedCatalog> {
  if (!usesSecret(profile)) {
    return deps.open(profile, undefined);
  }
  if (profile.kind === 'postgres' && profile.azureAuth === 'entra' && deps.entraToken) {
    // A new token for every open; a rejected one is no reason to ask for a password that does not exist.
    return deps.open(profile, await deps.entraToken(profile));
  }
  const stored = await deps.store.password(profile);
  try {
    return await deps.open(profile, stored);
  } catch (error) {
    if (!isAantjeError(error) || error.code !== 'AUTH_FAILED') {
      throw error;
    }
    const typed = await deps.askPassword(profile, stored !== undefined);
    if (!typed) {
      throw error;
    }
    return openAndStore(profile, typed, deps);
  }
}

async function openAndStore(
  profile: ConnectionProfile,
  password: string,
  deps: ConnectDeps,
): Promise<OpenedCatalog> {
  deps.store.registerPassword(password);
  const opened = await deps.open(profile, password);
  try {
    await deps.store.update(profile, password);
  } catch (error) {
    // Report the failed store, not a failed close after it.
    await opened.reader.close().catch(() => undefined);
    throw error;
  }
  return opened;
}
