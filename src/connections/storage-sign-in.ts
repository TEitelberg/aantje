import { storedValueNames } from '../storage/config';
import type { StorageValues, StoredValueName } from '../storage/config';
import type { WizardUi } from './ports';
import { effectiveStorage, validateRequired } from './profile';
import type { ConnectionProfile } from './profile';
import type { ConnectionStore } from './store';
import { SECRET_PROMPTS } from './storage-steps';

export interface StorageSignInDeps {
  readonly store: Pick<ConnectionStore, 'registerPassword' | 'storage'>;
  /** Runs after the new values are stored: open sessions of the connection use the old ones and must be closed. */
  afterStored(profile: ConnectionProfile): void | Promise<void>;
}

/**
 * Asks again for the secret values of the storage a connection has now (a new key, a new SAS token), and replaces the
 * stored ones. Nothing else of the connection changes. Returns whether values were stored; says so when the sign-in
 * of the storage keeps nothing in the secret storage.
 */
export async function setStorageSignInFlow(
  ui: WizardUi,
  profile: ConnectionProfile,
  deps: StorageSignInDeps,
): Promise<boolean> {
  const storage = effectiveStorage(profile);
  if (storage === undefined) {
    ui.info(
      `The connection "${profile.name}" has no storage of its own. Edit the connection to add one, or use "Set S3 Credentials" for the global S3 settings.`,
    );
    return false;
  }
  const names = storedValueNames(storage);
  if (names.length === 0) {
    ui.info(
      `The sign-in of the storage of "${profile.name}" keeps nothing in the secret storage: it uses your Microsoft account or the credential chain.`,
    );
    return false;
  }
  const values: Partial<Record<StoredValueName, string>> = {};
  for (const [index, name] of names.entries()) {
    const { label, prompt, optional } = SECRET_PROMPTS[name];
    const value = await ui.input({
      title: `Set Storage Sign-in "${profile.name}" (${index + 1}/${names.length})`,
      prompt: `${prompt}. It is kept in the secret storage, not in the settings.`,
      password: true,
      validate: optional ? undefined : validateRequired(label),
    });
    if (value === undefined) {
      return false;
    }
    if (value !== '') {
      values[name] = value;
    }
  }
  for (const value of Object.values(values)) {
    deps.store.registerPassword(value);
  }
  await deps.store.storage.set(profile.id, storage, values satisfies StorageValues);
  await deps.afterStored(profile);
  ui.info(`Stored the new sign-in of the storage of "${profile.name}".`);
  return true;
}
