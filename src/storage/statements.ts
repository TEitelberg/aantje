import { quoteLiteral } from '../catalog/ddl';
import { AantjeError } from '../errors';
import { ONELAKE_HOST, STORED_VALUE_NAMES } from './config';
import type {
  AwsStorage,
  AzureStorage,
  OneLakeStorage,
  ResolvedStorage,
  S3Storage,
  StorageConfig,
  StoredValueName,
} from './config';

const STORAGE_SECRET = 'aantje_storage';
// A connection without a `storage` of its own keeps the names its secrets always had.
const LEGACY_SECRET = { settings: 'aantje_s3', azureAccount: 'aantje_azure' } as const;

/** The name of the DuckDB secret of a storage. */
export function storageSecretName(storage: ResolvedStorage): string {
  return storage.legacy ? LEGACY_SECRET[storage.legacy] : STORAGE_SECRET;
}

/**
 * The statements that load what the storage needs, before the first secret and before the autoload switches go off:
 * `httpfs` for S3 and R2; `aws` only with the credential chain, because it adds a default secret for every `s3://` path;
 * `azure` for Azure and OneLake, with the curl transport on Linux. The azure extension's default transport looks for the
 * CA bundle only where Red Hat keeps it, so on Debian and Ubuntu every request fails with "Problem with the SSL CA
 * cert"; curl looks in the usual places. Windows keeps WinHTTP and its trust store.
 */
export function storageExtensions(
  storage: ResolvedStorage | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const { config } = storage ?? {};
  switch (config?.kind) {
    case 'aws':
      return config.signIn === 'chain'
        ? ['INSTALL httpfs', 'LOAD httpfs', 'INSTALL aws', 'LOAD aws']
        : ['INSTALL httpfs', 'LOAD httpfs'];
    case 's3':
      return ['INSTALL httpfs', 'LOAD httpfs'];
    case 'azure':
    case 'onelake': {
      const load = ['INSTALL azure', 'LOAD azure'];
      return platform === 'linux' ? [...load, "SET azure_transport_option_type = 'curl'"] : load;
    }
    default:
      return [];
  }
}

/**
 * The one `CREATE OR REPLACE SECRET` of the storage, or undefined when there is nothing to put in it (S3 without keys,
 * endpoint or region: DuckDB then uses its own defaults, or none for a public bucket). The same statement replaces the
 * secret when an Entra token is renewed. There is no scope: an engine belongs to one connection, and what its account
 * may read is the storage's decision. Every secret value appears here and nowhere else in the setup. A notebook passes
 * its own `name` (one per connection).
 */
export function storageSecretStatement(
  storage: ResolvedStorage,
  name: string = storageSecretName(storage),
): string | undefined {
  const fields = storageSecretFields(storage);
  return fields === undefined ? undefined : `CREATE OR REPLACE SECRET ${name} (${fields.join(', ')})`;
}

function storageSecretFields(storage: ResolvedStorage): string[] | undefined {
  const { config } = storage;
  return config.kind === 'aws'
    ? awsFields(config, storage)
    : config.kind === 's3'
      ? s3Fields(config, storage)
      : config.kind === 'azure'
        ? azureFields(config, storage)
        : oneLakeFields(config, storage);
}

/** One field of a secret statement: text parts, with the secret values that go between them. */
export interface SecretTemplateField {
  /** `parts.length === values.length + 1`: part 0, value 0, part 1, ... */
  readonly parts: readonly string[];
  readonly values: readonly (StoredValueName | 'accessToken')[];
  /** Only the optional values (a session token) appear here: the field is left out when the value is empty. */
  readonly optional: boolean;
}

const MARK = String.fromCharCode(1);
const MARKED = new RegExp(`${MARK}([A-Za-z]+)${MARK}`);
const OPTIONAL_VALUES: readonly string[] = ['sessionToken'];
const VALUE_NAMES: readonly (StoredValueName | 'accessToken')[] = [...STORED_VALUE_NAMES, 'accessToken'];

/**
 * The secret statement of a storage as a template, for code that cannot know the values when it is written (a
 * notebook). The fields come from the same builders as `storageSecretStatement`, called with a marker in place of each
 * value, so the two cannot drift apart: joining the fields with every marker replaced by its value yields exactly
 * `storageSecretStatement`. A value sits inside a quoted literal (`KEY_ID '<value>'`, or inside a longer connection
 * string); the caller escapes it for SQL. Undefined where the statement is.
 */
export function storageSecretTemplate(
  config: StorageConfig,
  name: string,
): { name: string; fields: SecretTemplateField[] } | undefined {
  // A configuration text that carried the marker would turn into a reference to a value.
  // JSON writes a control character as its escape.
  if (JSON.stringify(config).includes(String.raw`\u0001`)) {
    throw new AantjeError('INVALID_PROFILE', 'The storage configuration contains a control character.');
  }
  const values = Object.fromEntries(VALUE_NAMES.map((value) => [value, `${MARK}${value}${MARK}`]));
  const fields = storageSecretFields({ config, values });
  return fields === undefined
    ? undefined
    : {
        name,
        fields: fields.map((field) => {
          const split = field.split(MARKED);
          const parts = split.filter((_, index) => index % 2 === 0);
          const used = split.filter((_, index) => index % 2 === 1) as (StoredValueName | 'accessToken')[];
          return {
            parts,
            values: used,
            optional: used.length > 0 && used.every((value) => OPTIONAL_VALUES.includes(value)),
          };
        }),
      };
}

const literal = (name: string, value: string | undefined): string[] =>
  value === undefined || value === '' ? [] : [`${name} ${quoteLiteral(value)}`];

function awsFields(config: AwsStorage, { values }: ResolvedStorage): string[] | undefined {
  if (config.signIn === 'chain') {
    // The chain is checked when the secret is created, so an expired sign-in fails the attach with its own message.
    return [
      'TYPE s3',
      'PROVIDER credential_chain',
      ...literal('CHAIN', config.chain),
      ...literal('PROFILE', config.awsProfile),
      ...literal('REGION', config.region),
    ];
  }
  const fields = [
    ...literal('KEY_ID', values.keyId),
    ...literal('SECRET', values.secretKey),
    ...literal('SESSION_TOKEN', values.sessionToken),
    ...literal('REGION', config.region),
  ];
  return fields.length === 0 ? undefined : ['TYPE s3', ...fields];
}

// Also the global `aantje.s3.*` settings of a connection without storage: no endpoint and no account ID is allowed there.
function s3Fields(config: S3Storage, { values }: ResolvedStorage): string[] | undefined {
  const keys = [...literal('KEY_ID', values.keyId), ...literal('SECRET', values.secretKey)];
  if (config.accountId !== undefined) {
    return [
      'TYPE r2',
      ...keys,
      ...literal('REGION', config.region),
      `ACCOUNT_ID ${quoteLiteral(config.accountId)}`,
    ];
  }
  const fields = [...keys, ...literal('REGION', config.region)];
  const endpoint = config.endpoint?.trim() ?? '';
  if (endpoint !== '') {
    const { host, useSsl } = splitEndpoint(endpoint);
    fields.push(`ENDPOINT ${quoteLiteral(host)}`);
    if (useSsl !== undefined) {
      fields.push(`USE_SSL ${useSsl}`);
    }
  }
  fields.push(...literal('URL_STYLE', config.urlStyle));
  return keys.length === 0 && endpoint === '' ? undefined : ['TYPE s3', ...fields];
}

function azureFields(config: AzureStorage, { values }: ResolvedStorage): string[] {
  const account = `ACCOUNT_NAME ${quoteLiteral(config.account)}`;
  switch (config.signIn) {
    case 'entra':
      return [
        'TYPE azure',
        'PROVIDER access_token',
        `ACCESS_TOKEN ${quoteLiteral(values.accessToken ?? '')}`,
        account,
      ];
    case 'connectionString':
      return [
        'TYPE azure',
        'PROVIDER config',
        `CONNECTION_STRING ${quoteLiteral(values.connectionString ?? '')}`,
      ];
    case 'accountKey':
      // The key goes into a connection string, where `;` separates the parts: a key with one would add a part.
      return [
        'TYPE azure',
        'PROVIDER config',
        `CONNECTION_STRING ${quoteLiteral(
          `DefaultEndpointsProtocol=https;AccountName=${config.account};AccountKey=${part(values.accountKey, 'account key')};EndpointSuffix=core.windows.net`,
        )}`,
      ];
    case 'sas':
      return [
        'TYPE azure',
        'PROVIDER config',
        `CONNECTION_STRING ${quoteLiteral(
          `BlobEndpoint=https://${config.account}.blob.core.windows.net;SharedAccessSignature=${part((values.sasToken ?? '').replace(/^\?/, ''), 'SAS token')}`,
        )}`,
      ];
    case 'servicePrincipal':
      return ['TYPE azure', 'PROVIDER service_principal', ...principal(config, values), account];
    case 'chain':
      return ['TYPE azure', 'PROVIDER credential_chain', ...literal('CHAIN', config.chain), account];
  }
}

// OneLake is addressed by workspace in the path; the secret names the service instead of a storage account.
function oneLakeFields(config: OneLakeStorage, { values }: ResolvedStorage): string[] {
  const service = [`ACCOUNT_NAME ${quoteLiteral('onelake')}`, `ENDPOINT ${quoteLiteral(ONELAKE_HOST)}`];
  switch (config.signIn) {
    case 'entra':
      return [
        'TYPE azure',
        'PROVIDER access_token',
        `ACCESS_TOKEN ${quoteLiteral(values.accessToken ?? '')}`,
        ...service,
      ];
    case 'servicePrincipal':
      return ['TYPE azure', 'PROVIDER service_principal', ...principal(config, values), ...service];
    case 'chain':
      return ['TYPE azure', 'PROVIDER credential_chain', ...literal('CHAIN', config.chain), ...service];
  }
}

function principal(config: AzureStorage | OneLakeStorage, values: ResolvedStorage['values']): string[] {
  return [
    ...literal('TENANT_ID', config.tenant),
    ...literal('CLIENT_ID', config.clientId),
    ...(config.certificatePath === undefined
      ? literal('CLIENT_SECRET', values.clientSecret)
      : literal('CLIENT_CERTIFICATE_PATH', config.certificatePath)),
  ];
}

// A value that becomes one part of a `;`-separated connection string. The message names the value, never shows it.
function part(value: string | undefined, label: string): string {
  const text = value ?? '';
  if (text.includes(';')) {
    throw new AantjeError(
      'INVALID_PROFILE',
      `The stored ${label} contains a semicolon, which would split the connection string it is put in. Enter it again.`,
    );
  }
  return text;
}

// DuckDB wants the endpoint without a scheme; the scheme decides `USE_SSL`, else TLS applies.
function splitEndpoint(endpoint: string): { host: string; useSsl: boolean | undefined } {
  const match = /^(https?):\/\/(.*)$/i.exec(endpoint);
  const host = (match?.[2] ?? endpoint).replace(/\/+$/, '');
  return { host, useSsl: match ? match[1]?.toLowerCase() === 'https' : undefined };
}
