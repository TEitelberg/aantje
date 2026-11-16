import type { PostgresProfile } from '../connections/profile';
import { parseStorage, storageSettingEntry } from '../storage/config';
import type { AwsLakeOutputs } from './outputs';

/**
 * The providers of DuckDB's credential chain for a profile: never `env`, whose keys would come before the profile and
 * may belong to another store (the workbench of the Docker stack holds the RustFS keys there).
 */
export const PROFILE_CHAIN = 'sso;config;process';

/**
 * The connection of an AWS lake from the outputs of its stack: PostgreSQL on RDS over TLS (checked against the RDS
 * certificate authorities), and the bucket in `storage`, read with DuckDB's AWS credential chain and the same profile
 * that created the lake (the environment: the chain `env`).
 */
export function awsProfileOf(
  outputs: AwsLakeOutputs,
  name: string,
  newId: (name: string) => string,
  awsProfile: string | undefined,
  authentication: 'password' | 'iam' = 'password',
): PostgresProfile {
  const { host, port, database, user } = outputs.postgres;
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
        kind: 'aws',
        region: outputs.region,
        signIn: 'chain',
        ...(awsProfile === undefined ? { chain: 'env' } : { awsProfile, chain: PROFILE_CHAIN }),
      }),
    ),
    // IAM: the same profile signs the token that is the password of the user of the output (ducklake_iam).
    ...(authentication === 'iam'
      ? { awsAuth: 'iam' as const, ...(awsProfile === undefined ? {} : { awsProfile }) }
      : {}),
  };
}
