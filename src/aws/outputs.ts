import { AantjeError } from '../errors';
import { isObject } from '../guards';

/** The `ducklake` output of the template; it never holds the password. */
export interface AwsLakeOutputs {
  /** How PostgreSQL is signed in to: the password of the administrator, or IAM as `ducklake_iam`. */
  readonly authentication: 'password' | 'iam';
  readonly attach: string;
  readonly region: string;
  readonly bucket: string;
  readonly postgres: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
  };
  /** The account and the lake name of the stack, when the output names them. */
  readonly account?: string;
  readonly lake?: string;
}

const invalid = (why: string): AantjeError =>
  new AantjeError('INVALID_PROFILE', `This is not the output of an aantje AWS DuckLake stack: ${why}.`);

/** Reads the JSON of the `ducklake` output, as CloudFormation returns it (a string) or already parsed. */
export function parseAwsLakeOutputs(input: unknown): AwsLakeOutputs {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw invalid('it is not JSON');
    }
  }
  if (!isObject(value) || !isObject(value.postgres) || !isObject(value.s3Secret)) {
    throw invalid('"postgres" and "s3Secret" are missing');
  }
  const { attach } = value;
  const { host, port, database, user } = value.postgres;
  const { region, bucket } = value.s3Secret;
  if (typeof attach !== 'string' || typeof region !== 'string' || typeof bucket !== 'string' || !bucket) {
    throw invalid('"attach", the region or the bucket is missing');
  }
  if (typeof host !== 'string' || !host || typeof database !== 'string' || typeof user !== 'string') {
    throw invalid('the PostgreSQL host, database or user is missing');
  }
  const stack = isObject(value.stack) ? value.stack : {};
  return {
    authentication: value.authentication === 'iam' ? 'iam' : 'password',
    attach,
    region,
    bucket,
    postgres: { host, port: typeof port === 'number' ? port : 5432, database, user },
    ...(typeof stack.account === 'string' ? { account: stack.account } : {}),
    ...(typeof stack.lake === 'string' ? { lake: stack.lake } : {}),
  };
}

/** The `DATA_PATH` of the ready ATTACH statement. */
export function awsDataPathOf(outputs: AwsLakeOutputs): string {
  const path = /DATA_PATH '([^']+)'/.exec(outputs.attach)?.[1];
  if (!path) throw invalid('the ATTACH statement has no DATA_PATH');
  return path;
}
