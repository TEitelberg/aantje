// Allow My IP for an AWS DuckLake: a stack update of the parameter ClientIp, so that the rule of the security group
// never drifts from the stack. Free of the VS Code API.
import type { WizardUi } from '../connections/ports';
import { effectiveStorage, isAwsLake } from '../connections/profile';
import type { PostgresProfile } from '../connections/profile';
import { AantjeError } from '../errors';
import type { Logger } from '../log';
import type { AwsApi, AwsApiOptions } from './api';
import { awsError, credentialsName } from './errors';
import { followUpdate, newestEvent } from './follow';
import type { AwsLakeRegistry } from './registry';

export interface AwsAllowIpDeps {
  readonly api: (options: Omit<AwsApiOptions, 'debug'>) => Promise<AwsApi>;
  readonly publicIp: () => Promise<string>;
  readonly registry: Pick<AwsLakeRegistry, 'get'>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: Logger;
}

/** The region of an RDS host, `<id>.<hash>.<region>.rds.amazonaws.com`. */
export function regionOfRdsHost(host: string): string | undefined {
  return /\.([a-z]{2}(?:-[a-z]+)+-\d+)\.rds\.amazonaws\.com\.?$/i.exec(host.trim())?.[1]?.toLowerCase();
}

/**
 * Where the stack of a lake is and with which credentials it is read: a lake that aantje created knows its stack; an
 * imported one is found by its host in the region of its storage, with the profile of its storage.
 */
export function locateLake(
  profile: PostgresProfile,
  registry: Pick<AwsLakeRegistry, 'get'>,
): { readonly awsProfile: string | undefined; readonly region: string; readonly stackId?: string } {
  const created = registry.get(profile.id);
  if (created) return { awsProfile: created.awsProfile, region: created.region, stackId: created.stackId };
  const storage = effectiveStorage(profile);
  const aws = storage?.kind === 'aws' ? storage : undefined;
  const region = aws?.region ?? regionOfRdsHost(profile.host);
  if (region === undefined) {
    throw new AantjeError('INVALID_PROFILE', `aantje cannot tell the AWS region of "${profile.name}".`);
  }
  return { awsProfile: aws?.awsProfile, region };
}

/** Lets the current public IP reach PostgreSQL of an AWS lake. Returns whether the stack was changed. */
export async function allowAwsIpFlow(
  ui: WizardUi,
  profile: PostgresProfile,
  deps: AwsAllowIpDeps,
): Promise<boolean> {
  if (!isAwsLake(profile)) {
    ui.error(`"${profile.name}" is not an AWS lake, so aantje has no stack to change.`);
    return false;
  }
  const where = locateLake(profile, deps.registry);
  try {
    const ip = await ui.withProgress('Looking up your public IP address...', () => deps.publicIp());
    const api = await deps.api({ profile: where.awsProfile, region: where.region });
    const stack = await ui.withProgress('Looking for the stack of the lake...', () =>
      where.stackId === undefined ? api.findStackByHost(profile.host) : api.describeStack(where.stackId),
    );
    if (stack === undefined) {
      throw new AantjeError(
        'INVALID_PROFILE',
        `aantje found no stack of ${profile.host} in ${where.region} with ${credentialsName(where.awsProfile)}. Sign in to the account of the lake, or change the rule "client-ip" of its security group in the EC2 console.`,
      );
    }
    const current = stack.parameters.ClientIp;
    if (current === undefined) {
      throw new AantjeError(
        'INVALID_PROFILE',
        `The stack "${stack.name}" has no parameter ClientIp: it was not created from the template of aantje. Change its security group in the EC2 console.`,
      );
    }
    if (current === ip) {
      ui.info(
        `${ip} may reach "${profile.name}" already. If the connection still fails, the cause is another one.`,
      );
      return false;
    }
    const confirmed = await ui.confirm(
      `Allow your public IP address ${ip} to reach PostgreSQL of "${profile.name}"? A stack update of "${stack.name}" replaces ${current} in the rule "client-ip"; nothing else changes.`,
      'Allow',
    );
    if (!confirmed) return false;
    await ui.withProgress('Updating the stack...', async (report) => {
      const since = await newestEvent(api, stack.id);
      if ((await api.updateStack(stack.id, { ClientIp: ip })) === 'updating') {
        await followUpdate(
          {
            id: stack.id,
            name: stack.name,
            region: where.region,
            ...(where.awsProfile ? { awsProfile: where.awsProfile } : {}),
          },
          since,
          { api, sleep: deps.sleep, report, log: deps.log },
        );
      }
    });
    deps.log.info(
      `Allow My IP for "${profile.name}": the stack "${stack.name}" lets ${ip} reach PostgreSQL instead of ${current}.`,
    );
    ui.info(`${ip} may now reach "${profile.name}". Connect again.`);
    return true;
  } catch (error) {
    throw awsError(error, where.awsProfile);
  }
}
