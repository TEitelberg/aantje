import type { PickItem, WizardUi } from '../connections/ports';
import { isNameTaken } from '../connections/profile';
import type { AzureAuthMode, PostgresProfile } from '../connections/profile';
import { currentFirst } from '../connections/wizard';
import { parseStorage, storageSettingEntry } from '../storage/config';
import type { LakeOutputs } from './lake-outputs';

/**
 * The connection of an Azure lake from the outputs of its deployment. The data files are described by `storage` (Entra
 * sign-in, as every Azure lake always had); `azureTenant` stays for the Entra login to PostgreSQL.
 */
export function profileOf(
  outputs: LakeOutputs,
  name: string,
  newId: (name: string) => string,
  options: { tenant?: string; authentication?: AzureAuthMode; user?: string } = {},
): PostgresProfile {
  const { host, port, database } = outputs.postgres;
  const user = options.user ?? outputs.postgres.user;
  return {
    id: newId(name),
    name,
    kind: 'postgres',
    host,
    port,
    database,
    user,
    ssl: true,
    storage: parseStorage(
      storageSettingEntry({
        kind: 'azure',
        account: outputs.azureSecret.accountName,
        signIn: 'entra',
        ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
      }),
    ),
    ...(options.tenant === undefined ? {} : { azureTenant: options.tenant }),
    ...(options.authentication === 'entra' ? { azureAuth: 'entra' as const } : {}),
  };
}

/** `base`, or `base 2`, `base 3` and so on when another connection has that name. */
export function uniqueName(base: string, profiles: Parameters<typeof isNameTaken>[1]): string {
  let name = base;
  for (let n = 2; isNameTaken(name, profiles); n++) {
    name = `${base} ${n}`;
  }
  return name;
}

// Password stays the default until a real subscription has proven the Entra login; an imported lake starts with what its template set up.
export async function chooseAuthentication(
  ui: WizardUi,
  title: string,
  preferred: AzureAuthMode = 'password',
): Promise<AzureAuthMode | undefined> {
  const items: PickItem<AzureAuthMode>[] = [
    {
      label: 'Password',
      description: 'A generated password of the PostgreSQL administrator, kept in the secret storage',
      value: 'password',
    },
    {
      label: 'Microsoft Entra',
      description:
        'Your Microsoft account signs in with a token, nothing is stored; the password login stays as break-glass access',
      value: 'entra',
    },
  ];
  return ui.pick(title, currentFirst(items, preferred));
}

/** The sign-in to PostgreSQL in words, for the log. */
export const signInName = (authentication: AzureAuthMode): string =>
  authentication === 'entra' ? 'Microsoft Entra ID' : 'password';
