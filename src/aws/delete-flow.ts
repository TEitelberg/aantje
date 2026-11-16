// The dialog of Delete AWS DuckLake, on top of `WizardUi`. Free of the VS Code API.
import type { WizardUi } from '../connections/ports';
import type { PostgresProfile } from '../connections/profile';
import type { Logger } from '../log';
import { stackConsoleLink } from './api';
import type { AwsApi, AwsApiOptions } from './api';
import { awsError } from './errors';
import { databaseLeft, deleteAwsLake } from './delete-lake';
import type { DatabaseDeletion } from './delete-lake';
import type { AwsLakeRegistry, CreatedAwsLake } from './registry';

export interface AwsDeleteFlowDeps {
  readonly api: (options: Omit<AwsApiOptions, 'debug'>) => Promise<AwsApi>;
  readonly registry: Pick<
    AwsLakeRegistry,
    'get' | 'remove' | 'markDeleting' | 'noteSnapshot' | 'unfinishedDelete'
  >;
  /** Removes the connection with its password, its trust and its history. */
  readonly removeConnection: (profile: PostgresProfile) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: Logger;
  readonly now?: () => Date;
}

/**
 * Deletes an AWS lake that aantje created, after the name was typed, the final snapshot chosen and a last confirmation;
 * then the connection. From the confirmation until the end the registry notes the delete, so a delete that stops shows
 * on the connection (#83) and keeps it, so it can be run again.
 */
export async function deleteAwsLakeFlow(
  ui: WizardUi,
  profile: PostgresProfile,
  deps: AwsDeleteFlowDeps,
): Promise<boolean> {
  const lake = deps.registry.get(profile.id);
  if (!lake) {
    ui.error(
      `aantje did not create "${profile.name}", so it does not delete its AWS resources. Delete its stack in the CloudFormation console, then remove the connection.`,
    );
    return false;
  }
  const title = `Delete AWS DuckLake "${profile.name}"`;
  const typed = await ui.input({
    title,
    prompt: `This deletes the data. Type the name of the lake, "${profile.name}", to go on.`,
    validate: (value) => (value.trim() === profile.name ? undefined : 'The name does not match.'),
  });
  if (typed === undefined) return false;
  try {
    const api = await deps.api({ profile: lake.awsProfile, region: lake.region });
    const database = await chooseDatabase(ui, title, profile, lake, api, deps);
    if (database === undefined) return false;
    const confirmed = await ui.confirm(
      `Delete the stack "${lake.stackName}" in ${lake.region} (account ${lake.account}): the PostgreSQL database, the bucket "${lake.bucket}" with every file in it, and the VPC of the lake? The data cannot be restored${database === 'Snapshot' ? ', only the catalog from its final snapshot' : ''}. The connection "${profile.name}" is removed too.`,
      'Delete permanently',
    );
    if (!confirmed) return false;
    deps.log.info(
      `Delete AWS DuckLake "${profile.name}": stack "${lake.stackName}" in ${lake.region}, account ${lake.account}, bucket "${lake.bucket}", ${database === 'Snapshot' ? 'with' : 'without'} a final snapshot.`,
    );
    await deps.registry.markDeleting(profile.id, (deps.now ?? (() => new Date()))());
    const result = await ui.withProgress(`Deleting "${profile.name}"...`, (report) =>
      deleteAwsLake(lake, profile, database, {
        api,
        sleep: deps.sleep,
        report,
        log: deps.log,
        noteSnapshot: (snapshot) => deps.registry.noteSnapshot(profile.id, snapshot),
      }),
    );
    if (!result.deleted) {
      deps.log.error(`Deleting the stack "${lake.stackName}" failed: ${result.failed.join('; ')}`);
      ui.error(
        `CloudFormation could not delete everything of "${profile.name}": ${result.failed.join('; ') || 'see the events of the stack'}. What is left costs money; the connection stays, so Delete can run again. Details: ${stackConsoleLink(lake.region, lake.stackId)}`,
      );
      return false;
    }
    // Also the snapshot of an earlier run that stopped after deleting the database with it.
    const snapshot = result.snapshot ?? deps.registry.unfinishedDelete(profile.id)?.snapshot;
    await deps.removeConnection(profile);
    await deps.registry.remove(profile.id);
    deps.log.info(`Removed the connection "${profile.name}" and its password.`);
    const kept =
      snapshot === undefined
        ? ''
        : ` The final snapshot "${snapshot}" stays in RDS and costs until you delete it.`;
    deps.log.info(`Deleted the AWS DuckLake "${profile.name}".${kept}`);
    ui.info(`Deleted the AWS DuckLake "${profile.name}" and its connection.${kept}`);
    return true;
  } catch (error) {
    throw awsError(error, lake.awsProfile);
  }
}

/** Asks for a final snapshot only while there is a database to keep one of: a delete that stopped may have taken it. */
async function chooseDatabase(
  ui: WizardUi,
  title: string,
  profile: PostgresProfile,
  lake: CreatedAwsLake,
  api: AwsApi,
  deps: Pick<AwsDeleteFlowDeps, 'registry' | 'log'>,
): Promise<DatabaseDeletion | undefined> {
  if (deps.registry.unfinishedDelete(profile.id) !== undefined && !(await databaseLeft(api, lake))) {
    deps.log.info(
      `The database of "${profile.name}" is gone or being deleted by an earlier run: there is no final snapshot to ask for.`,
    );
    return 'Delete';
  }
  return ui.pick<DatabaseDeletion>(`${title}: the catalog`, [
    {
      label: 'Keep a final snapshot',
      description: 'RDS keeps a snapshot of the PostgreSQL catalog; it costs until you delete it',
      value: 'Snapshot',
    },
    { label: 'No snapshot', description: 'The catalog goes with the database', value: 'Delete' },
  ]);
}
