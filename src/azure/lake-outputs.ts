import { AantjeError } from '../errors';
import type { AzureAuthMode } from '../connections/profile';
import { isObject } from '../guards';

/** The `ducklake` output of the template; it never holds the password. */
export interface LakeOutputs {
  /** How the template set the server up; lakes of older deployments have no such field and use a password. */
  readonly authentication: AzureAuthMode;
  readonly attach: string;
  readonly azureSecret: { readonly provider: string; readonly accountName: string };
  readonly postgres: {
    readonly host: string;
    readonly database: string;
    readonly user: string;
    readonly port: number;
  };
}

const invalid = (why: string): AantjeError =>
  new AantjeError('INVALID_PROFILE', `This is not the output of an aantje DuckLake deployment: ${why}.`);

/**
 * Reads the JSON of the `ducklake` output. The portal shows the output as a string; a pasted `outputs` object of the
 * deployment, with the output under `ducklake.value`, works too.
 */
export function parseLakeOutputs(input: unknown): LakeOutputs {
  const value = typeof input === 'string' ? parseJson(input) : input;
  const wrapped = isObject(value) && isObject(value.ducklake) ? value.ducklake.value : undefined;
  const lake = wrapped === undefined ? value : typeof wrapped === 'string' ? parseJson(wrapped) : wrapped;
  if (!isObject(lake) || !isObject(lake.azureSecret) || !isObject(lake.postgres)) {
    throw invalid('"azureSecret" and "postgres" are missing');
  }
  const { attach } = lake;
  const { accountName } = lake.azureSecret;
  const { host, database, user, port } = lake.postgres;
  if (typeof attach !== 'string' || typeof accountName !== 'string' || !accountName) {
    throw invalid('"attach" or the account name is missing');
  }
  if (typeof host !== 'string' || typeof database !== 'string' || typeof user !== 'string' || !host) {
    throw invalid('the PostgreSQL host, database or user is missing');
  }
  return {
    authentication: lake.authentication === 'entra' ? 'entra' : 'password',
    attach,
    azureSecret: {
      provider: typeof lake.azureSecret.provider === 'string' ? lake.azureSecret.provider : 'access_token',
      accountName,
    },
    postgres: { host, database, user, port: typeof port === 'number' ? port : 5432 },
  };
}

/** The `DATA_PATH` of the ready ATTACH statement. */
export function dataPathOf(outputs: LakeOutputs): string {
  const path = /DATA_PATH '([^']+)'/.exec(outputs.attach)?.[1];
  if (!path) {
    throw invalid('the ATTACH statement has no DATA_PATH');
  }
  return path;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw invalid('it is not JSON');
  }
}
