// The token of IAM database authentication for a PostgreSQL connection on Amazon RDS (`awsAuth: "iam"`): signed with
// the AWS profile of the connection, valid for 15 minutes, fetched for every connect and renewed by a long session.
import { effectiveStorage } from '../connections/profile';
import type { PostgresProfile } from '../connections/profile';
import { AantjeError } from '../errors';
import { regionOfRdsHost } from './allow-ip';
import { awsError } from './errors';
import { loadAwsSdk } from './load';

/** The AWS profile that signs the token: the one of the connection, else the one of its AWS storage. */
export function iamProfileOf(profile: PostgresProfile): string | undefined {
  const storage = effectiveStorage(profile);
  return profile.awsProfile ?? (storage?.kind === 'aws' ? storage.awsProfile : undefined);
}

/** Makes tokens with the SDK bundle at `sdkPath`; each token is registered with the log redactor. */
export function createAwsDbToken(
  sdkPath: string,
  register: (value: string) => void,
): (profile: PostgresProfile) => Promise<string> {
  return async (profile) => {
    const storage = effectiveStorage(profile);
    const region = regionOfRdsHost(profile.host) ?? (storage?.kind === 'aws' ? storage.region : undefined);
    if (region === undefined) {
      throw new AantjeError(
        'INVALID_PROFILE',
        `aantje cannot tell the AWS region of ${profile.host} for its IAM token: it is no host of Amazon RDS.`,
      );
    }
    const awsProfile = iamProfileOf(profile);
    try {
      const token = await loadAwsSdk(sdkPath).rdsAuthToken({
        profile: awsProfile,
        region,
        host: profile.host,
        port: profile.port,
        user: profile.user,
      });
      register(token);
      return token;
    } catch (error) {
      throw awsError(error, awsProfile);
    }
  };
}
