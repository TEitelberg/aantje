import type { WizardUi } from '../connections/ports';
import type { PostgresProfile } from '../connections/profile';
import type { ConnectionStore } from '../connections/store';
import { nameValidator, SAVE_OR_DISCARD } from '../connections/wizard';
import { userMessageOf } from '../errors';
import type { Logger } from '../log';
import { parseLakeOutputs } from './lake-outputs';
import type { LakeOutputs } from './lake-outputs';
import { chooseAuthentication, profileOf, signInName, uniqueName } from './lake-profile';

export interface ImportFlowDeps {
  readonly store: Pick<ConnectionStore, 'list' | 'newId' | 'add' | 'registerPassword'>;
  readonly clipboard: () => Promise<string>;
  /** Opens the catalog with the password, or with a token when the profile uses Entra; rejects with a message for the user. */
  readonly test: (profile: PostgresProfile, password: string | undefined) => Promise<void>;
  /** The user principal name of the signed-in Microsoft account: the login of an Entra connection. Signs in if needed. */
  readonly entraUser: () => Promise<string>;
  readonly log: Logger;
}

/** Turns the `ducklake` output of a deployment (portal or CI) into a connection; the password is asked for. */
export async function importLakeFlow(
  ui: WizardUi,
  deps: ImportFlowDeps,
): Promise<PostgresProfile | undefined> {
  const outputs = await readOutputs(ui, deps);
  if (outputs === undefined) {
    return undefined;
  }
  const name = await ui.input({
    title: 'Import Azure DuckLake (2/4)',
    prompt: 'Name shown in the explorer',
    value: uniqueName(outputs.postgres.host.split('.')[0] ?? 'azure-lake', deps.store.list()),
    validate: nameValidator(deps.store.list()),
  });
  if (name === undefined) {
    return undefined;
  }
  const authentication = await chooseAuthentication(
    ui,
    'Import Azure DuckLake (3/4): sign-in to PostgreSQL',
    outputs.authentication,
  );
  if (authentication === undefined) {
    return undefined;
  }
  const entra = authentication === 'entra';
  const password = entra
    ? undefined
    : await ui.input({
        title: 'Import Azure DuckLake (4/4)',
        prompt:
          'Password of the PostgreSQL administrator. It is kept in the secret storage, not in the settings.',
        password: true,
        validate: (value) => (value === '' ? 'The password must not be empty.' : undefined),
      });
  if (!entra && password === undefined) {
    return undefined;
  }
  // The log redactor knows the password before the connection test, whose error text may repeat it.
  deps.store.registerPassword(password);
  const profile = profileOf(outputs, name.trim(), (value) => deps.store.newId(value), {
    authentication,
    user: entra ? await deps.entraUser() : undefined,
  });
  deps.log.info(
    `Import Azure DuckLake "${profile.name}": ${profile.host}:${profile.port}/${profile.database} as ${profile.user}, storage account "${outputs.azureSecret.accountName}", sign-in ${signInName(authentication)}.`,
  );
  try {
    await ui.withProgress(`Testing connection "${profile.name}"...`, () => deps.test(profile, password));
    deps.log.info(`The connection test of "${profile.name}" passed.`);
  } catch (error) {
    deps.log.warn(`The connection test of "${profile.name}" failed: ${userMessageOf(error)}`);
    ui.error(`Connection test failed: ${userMessageOf(error)}`);
    const choice = await ui.pick('The connection test failed', SAVE_OR_DISCARD);
    if (choice !== 'save') {
      deps.log.info(`Import of "${profile.name}" cancelled.`);
      return undefined;
    }
  }
  await deps.store.add(profile, password);
  deps.log.info(`Saved the connection "${profile.name}".`);
  ui.info(
    `Saved connection "${profile.name}".${entra ? ` The user "${profile.user}" must be a PostgreSQL role of the server: the Entra administrator is one, anyone else needs a role (see the documentation).` : ''} The data files are read with your Microsoft account, which needs the role Storage Blob Data Contributor or Reader on the storage account "${outputs.azureSecret.accountName}".`,
  );
  return profile;
}

async function readOutputs(ui: WizardUi, deps: ImportFlowDeps): Promise<LakeOutputs | undefined> {
  const fromClipboard = await deps.clipboard().then(
    (text) => parse(text),
    () => undefined,
  );
  if (
    fromClipboard &&
    (await ui.confirm('Import the Azure DuckLake described by the JSON on the clipboard?', 'Import'))
  ) {
    return fromClipboard;
  }
  const text = await ui.input({
    title: 'Import Azure DuckLake (1/4)',
    prompt: 'Paste the value of the output "ducklake" of the deployment (JSON)',
    validate: (value) =>
      parse(value) ? undefined : 'This is not the output of an aantje DuckLake deployment.',
  });
  return text === undefined ? undefined : parse(text);
}

function parse(text: string): LakeOutputs | undefined {
  try {
    return parseLakeOutputs(text);
  } catch {
    return undefined;
  }
}
