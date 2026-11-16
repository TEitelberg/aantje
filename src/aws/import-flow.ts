// The dialog of Import AWS DuckLake: a stack of deploy/aws/template.yaml that was created by hand (CLI or console)
// becomes a connection. Free of the VS Code API.
import type { WizardUi } from '../connections/ports';
import type { PostgresProfile } from '../connections/profile';
import type { ConnectionStore } from '../connections/store';
import { nameValidator, SAVE_OR_DISCARD } from '../connections/wizard';
import { userMessageOf } from '../errors';
import type { Logger } from '../log';
import { uniqueName } from '../azure/lake-profile';
import { chooseAwsProfile, chooseAwsSignIn, ENVIRONMENT } from './create-flow';
import type { AwsFlowDeps } from './create-flow';
import { credentialsName } from './errors';
import { awsProfileOf } from './lake-profile';
import { parseAwsLakeOutputs } from './outputs';
import type { AwsLakeOutputs } from './outputs';

export interface AwsImportFlowDeps extends Pick<AwsFlowDeps, 'profiles' | 'environment'> {
  readonly store: Pick<ConnectionStore, 'list' | 'newId' | 'add' | 'registerPassword'>;
  readonly clipboard: () => Promise<string>;
  /** Opens the catalog with the password; rejects with a message for the user. */
  readonly test: (profile: PostgresProfile, password: string | undefined) => Promise<void>;
  readonly log: Logger;
}

const TITLE = 'Import AWS DuckLake';

/** Turns the `ducklake` output of a stack into a connection; the profile for the bucket and the password are asked for. */
export async function importAwsLakeFlow(
  ui: WizardUi,
  deps: AwsImportFlowDeps,
): Promise<PostgresProfile | undefined> {
  const outputs = await readOutputs(ui, deps);
  if (outputs === undefined) return undefined;
  const name = await ui.input({
    title: `${TITLE} (2/5)`,
    prompt: 'Name shown in the explorer',
    value: uniqueName(outputs.lake ?? outputs.postgres.host.split('.')[0] ?? 'aws-lake', deps.store.list()),
    validate: nameValidator(deps.store.list()),
  });
  if (name === undefined) return undefined;
  const source = await chooseAwsProfile(ui, `${TITLE} (3/5): AWS profile for the bucket`, deps);
  if (source === undefined) return undefined;
  const awsProfile = source.name === ENVIRONMENT ? undefined : source.name;
  const authentication = await chooseAwsSignIn(
    ui,
    `${TITLE} (4/5): sign-in to PostgreSQL`,
    outputs.authentication,
  );
  if (authentication === undefined) return undefined;
  const password =
    authentication === 'iam'
      ? ''
      : await ui.input({
          title: `${TITLE} (5/5)`,
          prompt: `Password of the PostgreSQL user "${outputs.postgres.user}". It is kept in the secret storage, not in the settings.`,
          password: true,
          validate: (value) => (value === '' ? 'The password must not be empty.' : undefined),
        });
  if (password === undefined) return undefined;
  // The log redactor knows the password before the connection test, whose error text may repeat it.
  if (password !== '') deps.store.registerPassword(password);
  const profile = awsProfileOf(
    outputs,
    name.trim(),
    (value) => deps.store.newId(value),
    awsProfile,
    authentication,
  );
  deps.log.info(
    `Import AWS DuckLake "${profile.name}": ${profile.host}:${profile.port}/${profile.database} as ${profile.user}, bucket "${outputs.bucket}" in ${outputs.region}, read with ${credentialsName(awsProfile)}.`,
  );
  try {
    await ui.withProgress(`Testing connection "${profile.name}"...`, () =>
      deps.test(profile, password === '' ? undefined : password),
    );
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
  await deps.store.add(profile, password === '' ? undefined : password);
  deps.log.info(`Saved the connection "${profile.name}".`);
  ui.info(
    `Saved connection "${profile.name}". The data files are read with ${credentialsName(awsProfile)}, which needs access to the bucket "${outputs.bucket}". aantje did not create this lake, so it does not delete it.`,
  );
  return profile;
}

async function readOutputs(ui: WizardUi, deps: AwsImportFlowDeps): Promise<AwsLakeOutputs | undefined> {
  const fromClipboard = await deps.clipboard().then(parse, () => undefined);
  if (
    fromClipboard &&
    (await ui.confirm('Import the AWS DuckLake described by the JSON on the clipboard?', 'Import'))
  ) {
    return fromClipboard;
  }
  const text = await ui.input({
    title: `${TITLE} (1/5)`,
    prompt: 'Paste the value of the output "ducklake" of the stack (JSON)',
    validate: (value) =>
      parse(value) ? undefined : 'This is not the output of an aantje AWS DuckLake stack.',
  });
  return text === undefined ? undefined : parse(text);
}

function parse(text: string): AwsLakeOutputs | undefined {
  try {
    return parseAwsLakeOutputs(text);
  } catch {
    return undefined;
  }
}
