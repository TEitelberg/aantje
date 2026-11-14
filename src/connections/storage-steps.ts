import type {
  AwsStorage,
  AzureSignIn,
  AzureStorage,
  OneLakeSignIn,
  OneLakeStorage,
  S3Storage,
  StorageConfig,
  StorageValues,
  StoredValueName,
} from '../storage/config';
import {
  storedValueNames,
  validateAwsProfile,
  validateAwsRegion,
  validateCertificatePath,
  validateClientId,
  validateR2AccountId,
  validateS3Endpoint,
  validateStorageAccountName,
  validateTenantId,
} from '../storage/config';
import { locate } from '../storage/location';
import type { StorageSecretStore } from '../storage/secrets';
import type { PickItem, WizardUi } from './ports';
import type { ConnectionProfile } from './profile';
import { validateRequired } from './profile';

// The questions about the storage of a connection: where the data files live and how aantje signs in there. They come
// after the questions about the catalog. Secret values are asked as password inputs and go to the secret storage; the
// answers that make the `storage` entry of the profile are plain text.

export type StorageKindAnswer = 'none' | 'aws' | 's3' | 'azure' | 'onelake';

export type StorageField =
  | 'storageKind'
  | 'storageSignIn'
  | 's3Flavor'
  | 'storageEndpoint'
  | 'storageAccountId'
  | 'storageRegion'
  | 'storageUrlStyle'
  | 'awsProfile'
  | 'storageAccount'
  | 'storageTenant'
  | 'storageClientId'
  | 'storagePrincipal'
  | 'storageCertificate';

export type StorageAnswers = Record<StorageField | StoredValueName, string>;

/** What the questions see of the answers: their own and the tenant that signs in to PostgreSQL, which prefills theirs. */
type StepAnswers = StorageAnswers & { readonly tenant: string };

/** One question; the wizard runs it like its own steps. `answers` is the whole answer set, of which this file reads its part. */
export interface StorageStep {
  readonly field: StorageField | StoredValueName;
  readonly prompt: string;
  readonly validate?: (value: string) => string | undefined;
  readonly password?: boolean;
  readonly choices?: readonly PickItem<string>[];
  readonly ask?: (heading: string, answers: StepAnswers) => Promise<string | undefined>;
  readonly skip?: (answers: StepAnswers) => boolean;
}

const NONE = 'none';

export function blankStorageAnswers(): StorageAnswers {
  return {
    storageKind: '',
    storageSignIn: '',
    s3Flavor: 'endpoint',
    storageEndpoint: '',
    storageAccountId: '',
    storageRegion: '',
    storageUrlStyle: 'path',
    awsProfile: '',
    storageAccount: '',
    storageTenant: '',
    storageClientId: '',
    storagePrincipal: 'secret',
    storageCertificate: '',
    keyId: '',
    secretKey: '',
    sessionToken: '',
    connectionString: '',
    accountKey: '',
    sasToken: '',
    clientSecret: '',
  };
}

/** The answers that a storage stands for, to prefill an edit. No storage is the answer `none`. */
export function storageAnswersOf(storage: StorageConfig | undefined): StorageAnswers {
  const answers = blankStorageAnswers();
  if (storage === undefined) {
    return { ...answers, storageKind: NONE };
  }
  const base = { ...answers, storageKind: storage.kind, storageSignIn: storage.signIn };
  switch (storage.kind) {
    case 'aws':
      return { ...base, storageRegion: storage.region ?? '', awsProfile: storage.awsProfile ?? '' };
    case 's3':
      return {
        ...base,
        s3Flavor: storage.accountId === undefined ? 'endpoint' : 'r2',
        storageEndpoint: storage.endpoint ?? '',
        storageAccountId: storage.accountId ?? '',
        storageRegion: storage.region ?? '',
        storageUrlStyle: storage.urlStyle ?? '',
      };
    case 'azure':
      return {
        ...base,
        storageAccount: storage.account,
        ...principalAnswers(storage),
      };
    case 'onelake':
      return { ...base, ...principalAnswers(storage) };
  }
}

function principalAnswers(storage: AzureStorage | OneLakeStorage): Partial<StorageAnswers> {
  return {
    storageTenant: storage.tenant ?? '',
    storageClientId: storage.clientId ?? '',
    storagePrincipal: storage.certificatePath === undefined ? 'secret' : 'certificate',
    storageCertificate: storage.certificatePath ?? '',
  };
}

const put = <K extends string>(key: K, value: string): Partial<Record<K, string>> =>
  (value === '' ? {} : { [key]: value }) as Partial<Record<K, string>>;

/**
 * The storage the answers describe; undefined for `none`. It assembles what was answered and does not validate: each
 * question validates its own input.
 */
export function storageOf(answers: StorageAnswers): StorageConfig | undefined {
  const { storageSignIn: signIn } = answers;
  switch (answers.storageKind) {
    case 'aws': {
      const chain = signIn === 'chain';
      return {
        kind: 'aws',
        signIn: chain ? 'chain' : 'keys',
        ...put('region', answers.storageRegion),
        ...(chain ? put('awsProfile', answers.awsProfile) : {}),
      } satisfies AwsStorage;
    }
    case 's3': {
      const r2 = answers.s3Flavor === 'r2';
      return {
        kind: 's3',
        signIn: 'keys',
        ...(r2 ? put('accountId', answers.storageAccountId) : put('endpoint', answers.storageEndpoint)),
        ...put('region', answers.storageRegion),
        ...(r2 || answers.storageUrlStyle === ''
          ? {}
          : { urlStyle: answers.storageUrlStyle === 'vhost' ? ('vhost' as const) : ('path' as const) }),
      } satisfies S3Storage;
    }
    case 'azure':
      return {
        kind: 'azure',
        account: answers.storageAccount,
        signIn: signIn as AzureSignIn,
        ...principalOf(answers),
      } satisfies AzureStorage;
    case 'onelake':
      return {
        kind: 'onelake',
        signIn: signIn as OneLakeSignIn,
        ...principalOf(answers),
      } satisfies OneLakeStorage;
    default:
      return undefined;
  }
}

function principalOf(answers: StorageAnswers): {
  tenant?: string;
  clientId?: string;
  certificatePath?: string;
} {
  const signIn = answers.storageSignIn;
  if (signIn === 'servicePrincipal') {
    return {
      ...put('tenant', answers.storageTenant),
      ...put('clientId', answers.storageClientId),
      ...(answers.storagePrincipal === 'certificate'
        ? put('certificatePath', answers.storageCertificate)
        : {}),
    };
  }
  return signIn === 'entra' ? put('tenant', answers.storageTenant) : {};
}

/** Whether two storages are the same configuration. */
export function sameStorage(a: StorageConfig | undefined, b: StorageConfig | undefined): boolean {
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

function sorted(storage: StorageConfig | undefined): unknown {
  return storage === undefined
    ? null
    : Object.fromEntries(Object.entries(storage).sort(([x], [y]) => x.localeCompare(y)));
}

/**
 * The values to store for the answers: the typed ones, completed by the stored ones for a value left empty. Undefined
 * when nothing was typed: the stored values stay as they are (or none are stored).
 */
export function storageValuesOf(
  config: StorageConfig,
  answers: StorageAnswers,
  kept: StorageValues | undefined,
): StorageValues | undefined {
  const names = storedValueNames(config);
  if (!names.some((name) => answers[name] !== '')) {
    return undefined;
  }
  const values: Partial<Record<StoredValueName, string>> = {};
  for (const name of names) {
    const value = answers[name] || kept?.[name];
    if (value) {
      values[name] = value;
    }
  }
  return values;
}

const KIND_ITEMS: readonly PickItem<StorageKindAnswer>[] = [
  {
    label: 'None',
    description: 'Local data files, or the global aantje.s3.* settings and S3 credentials',
    value: 'none',
  },
  { label: 'AWS S3', description: 'Amazon S3 itself', value: 'aws' },
  {
    label: 'S3-compatible (MinIO, R2, Wasabi...)',
    description: 'An object store with an S3 API, such as MinIO, RustFS, Wasabi or Cloudflare R2',
    value: 's3',
  },
  {
    label: 'Azure ADLS Gen2 / Blob',
    description: 'A storage account of Azure Data Lake Storage Gen2 or Blob storage',
    value: 'azure',
  },
  {
    label: 'Microsoft Fabric OneLake',
    description: 'A workspace of Microsoft Fabric (abfss://...@onelake.dfs.fabric.microsoft.com)',
    value: 'onelake',
  },
];

const FLAVOR_ITEMS: readonly PickItem<string>[] = [
  {
    label: 'S3 endpoint',
    description: 'MinIO, RustFS, Wasabi, Ceph or another server with an S3 API',
    value: 'endpoint',
  },
  { label: 'Cloudflare R2', description: 'The address follows from the account ID', value: 'r2' },
];

const URL_STYLE_ITEMS: readonly PickItem<string>[] = [
  { label: 'Path style', description: 'https://host/bucket/key: MinIO, RustFS, Ceph', value: 'path' },
  {
    label: 'Virtual-host style',
    description: 'https://bucket.host/key: AWS and most hosted services',
    value: 'vhost',
  },
  { label: 'DuckDB default', description: 'Leave it unset', value: '' },
];

const AWS_SIGN_INS: readonly PickItem<string>[] = [
  {
    label: 'Access keys',
    description: 'A key ID and a secret key, kept in the secret storage',
    value: 'keys',
  },
  {
    label: 'Credential chain',
    description: 'What the AWS SDK finds: environment, SSO, shared profile, instance role',
    value: 'chain',
  },
];

const AZURE_SIGN_INS: readonly PickItem<string>[] = [
  {
    label: 'Microsoft account (Entra ID)',
    description: 'The Microsoft account of VS Code signs in with a token; nothing is stored',
    value: 'entra',
  },
  {
    label: 'Connection string',
    description: 'Of the storage account, kept in the secret storage',
    value: 'connectionString',
  },
  {
    label: 'Account key',
    description: 'A key of the storage account, kept in the secret storage',
    value: 'accountKey',
  },
  { label: 'SAS token', description: 'A shared access signature, kept in the secret storage', value: 'sas' },
  {
    label: 'Service principal',
    description: 'An app registration with a client secret or a certificate',
    value: 'servicePrincipal',
  },
  {
    label: 'Credential chain',
    description: 'What Azure finds: environment, Azure CLI, managed identity',
    value: 'chain',
  },
];

const ONELAKE_SIGN_INS: readonly PickItem<string>[] = [
  AZURE_SIGN_INS[0] as PickItem<string>,
  AZURE_SIGN_INS[4] as PickItem<string>,
  AZURE_SIGN_INS[5] as PickItem<string>,
];

const PRINCIPAL_ITEMS: readonly PickItem<string>[] = [
  { label: 'Client secret', description: 'Kept in the secret storage', value: 'secret' },
  {
    label: 'Certificate',
    description: 'The path of a certificate file on this machine',
    value: 'certificate',
  },
];

export const SECRET_PROMPTS: Readonly<
  Record<StoredValueName, { readonly label: string; readonly prompt: string; readonly optional?: boolean }>
> = {
  keyId: { label: 'Access key ID', prompt: 'Access key ID' },
  secretKey: { label: 'Secret key', prompt: 'Secret access key' },
  sessionToken: {
    label: 'Session token',
    prompt: 'Session token of temporary keys (leave empty for long-lived keys)',
    optional: true,
  },
  connectionString: { label: 'Connection string', prompt: 'Connection string of the storage account' },
  accountKey: { label: 'Account key', prompt: 'Account key of the storage account' },
  sasToken: { label: 'SAS token', prompt: 'SAS token (the part after the ? of a SAS URL)' },
  clientSecret: { label: 'Client secret', prompt: 'Client secret of the app registration' },
};

const optionalWith =
  (validate: (value: string) => string | undefined) =>
  (value: string): string | undefined =>
    value.trim() === '' ? undefined : validate(value);

export interface StorageStepEnv {
  readonly ui: WizardUi;
  /** The stored sign-in values; an edit leaves a secret prompt empty to keep them. */
  readonly secrets: Pick<StorageSecretStore, 'get'>;
  /** The id of the connection being edited. */
  readonly existingId: string | undefined;
  /**
   * The `data_path` of the catalog: a string; null when it has none; undefined when it cannot be read (no catalog
   * reachable yet), so that the user is asked.
   */
  readonly dataPath: () => Promise<string | null | undefined>;
  /** Whether the edited connection has a storage of its own (or the legacy Azure account), which decides the preselected kind. */
  readonly hasStorage: boolean;
}

const is =
  (...kinds: StorageKindAnswer[]) =>
  (answers: StorageAnswers): boolean =>
    kinds.includes(answers.storageKind as StorageKindAnswer);

const isNot =
  (...kinds: StorageKindAnswer[]) =>
  (answers: StorageAnswers): boolean =>
    !is(...kinds)(answers);

const usesPrincipal = (answers: StorageAnswers): boolean =>
  is('azure', 'onelake')(answers) && answers.storageSignIn === 'servicePrincipal';

function kindStep(env: StorageStepEnv): StorageStep {
  const { ui } = env;
  const pick = (heading: string, prompt: string, items: readonly PickItem<string>[], current: string) =>
    ui.pick(`${heading}: ${prompt}`, currentFirst(items, current));
  return {
    field: 'storageKind',
    prompt: 'Where are the data files of the lake stored?',
    ask: async (heading, answers) => {
      const path = await env.dataPath();
      const found = path === undefined || path === null || path.trim() === '' ? undefined : locate(path);
      // A local lake needs no storage. A connection that has one keeps the question, so that it can be removed.
      if (found?.family === 'local' && !env.hasStorage) {
        return NONE;
      }
      const proposed = proposeKind(found?.family);
      const current = answers.storageKind === '' ? proposed : answers.storageKind;
      const kind = await pick(
        heading,
        found === undefined
          ? 'where are the data files of the lake stored?'
          : `the data path of the catalog is ${path ?? ''}. Where are the data files stored?`,
        KIND_ITEMS,
        current,
      );
      if (kind === undefined) {
        return undefined;
      }
      if (found?.account !== undefined && answers.storageAccount === '') {
        answers.storageAccount = found.account;
      }
      if (found?.family === 'r2') {
        answers.s3Flavor = 'r2';
      }
      return kind;
    },
  };
}

/** The storage questions in the order they are asked; each one skips itself when it does not apply to the answers. */
export function storageSteps(env: StorageStepEnv): StorageStep[] {
  const { ui } = env;
  const pick = (heading: string, prompt: string, items: readonly PickItem<string>[], current: string) =>
    ui.pick(`${heading}: ${prompt}`, currentFirst(items, current));

  const kept = async (answers: StorageAnswers): Promise<StorageValues | undefined> => {
    const config = storageOf(answers);
    return env.existingId === undefined || config === undefined
      ? undefined
      : env.secrets.get(env.existingId, config);
  };

  const secretStep = (name: StoredValueName): StorageStep => {
    const { label, prompt, optional } = SECRET_PROMPTS[name];
    return {
      field: name,
      prompt,
      password: true,
      skip: (answers) => {
        const config = storageOf(answers);
        return config === undefined || !storedValueNames(config).includes(name);
      },
      ask: async (heading, answers) => {
        const stored = (await kept(answers))?.[name] !== undefined;
        return ui.input({
          title: heading,
          prompt: stored
            ? `${prompt} (leave empty to keep the stored value)`
            : `${prompt}. It is kept in the secret storage, not in the settings.`,
          value: answers[name],
          password: true,
          validate: optional || stored ? undefined : validateRequired(label),
        });
      },
    };
  };

  return [
    kindStep(env),
    {
      field: 'storageAccount',
      prompt: 'Storage account name (3 to 24 lowercase letters and digits)',
      validate: validateStorageAccountName,
      skip: isNot('azure'),
    },
    {
      field: 'storageSignIn',
      prompt: 'How does aantje sign in to the storage?',
      skip: isNot('aws', 'azure', 'onelake'),
      ask: (heading, answers) =>
        pick(
          heading,
          'how does aantje sign in to the storage?',
          answers.storageKind === 'aws'
            ? AWS_SIGN_INS
            : answers.storageKind === 'onelake'
              ? ONELAKE_SIGN_INS
              : AZURE_SIGN_INS,
          answers.storageSignIn,
        ),
    },
    {
      field: 's3Flavor',
      prompt: 'Which kind of S3-compatible store is it?',
      choices: FLAVOR_ITEMS,
      skip: isNot('s3'),
    },
    {
      field: 'storageEndpoint',
      prompt: 'Address of the S3 API as host:port or http(s)://host:port, without a path',
      validate: validateS3Endpoint,
      skip: (answers) => isNot('s3')(answers) || answers.s3Flavor === 'r2',
    },
    {
      field: 'storageAccountId',
      prompt: 'Cloudflare account ID (32 hexadecimal digits)',
      validate: validateR2AccountId,
      skip: (answers) => isNot('s3')(answers) || answers.s3Flavor !== 'r2',
    },
    {
      field: 'storageRegion',
      prompt: 'Region, for example eu-central-1 (leave empty for the default)',
      validate: optionalWith(validateAwsRegion),
      skip: isNot('aws', 's3'),
    },
    {
      field: 'storageUrlStyle',
      prompt: 'How are buckets addressed?',
      choices: URL_STYLE_ITEMS,
      skip: (answers) => isNot('s3')(answers) || answers.s3Flavor === 'r2',
    },
    {
      field: 'awsProfile',
      prompt: 'Name of the AWS profile to use (leave empty for the default profile)',
      validate: optionalWith(validateAwsProfile),
      skip: (answers) => isNot('aws')(answers) || answers.storageSignIn !== 'chain',
    },
    {
      field: 'storageTenant',
      prompt: 'Directory (tenant) ID',
      skip: (answers) =>
        isNot('azure', 'onelake')(answers) || !['entra', 'servicePrincipal'].includes(answers.storageSignIn),
      ask: (heading, answers) =>
        ui.input({
          title: heading,
          prompt:
            answers.storageSignIn === 'servicePrincipal'
              ? 'Directory (tenant) ID of the app registration'
              : 'Directory (tenant) ID to sign in to with your Microsoft account. Leave empty for the home tenant of the account.',
          // The tenant that signs in to PostgreSQL is usually the one of the storage.
          value: answers.storageTenant || answers.tenant,
          validate:
            answers.storageSignIn === 'servicePrincipal'
              ? (value) => validateRequired('Tenant ID')(value) ?? validateTenantId(value)
              : validateTenantId,
        }),
    },
    {
      field: 'storageClientId',
      prompt: 'Client (application) ID of the app registration',
      validate: validateClientId,
      skip: (answers) => !usesPrincipal(answers),
    },
    {
      field: 'storagePrincipal',
      prompt: 'How does the app registration prove itself?',
      choices: PRINCIPAL_ITEMS,
      skip: (answers) => !usesPrincipal(answers),
    },
    {
      field: 'storageCertificate',
      prompt: 'Path of the certificate file of the app registration',
      validate: (value) => validateRequired('Certificate path')(value) ?? validateCertificatePath(value),
      skip: (answers) => !usesPrincipal(answers) || answers.storagePrincipal !== 'certificate',
    },
    secretStep('keyId'),
    secretStep('secretKey'),
    secretStep('sessionToken'),
    secretStep('connectionString'),
    secretStep('accountKey'),
    secretStep('sasToken'),
    secretStep('clientSecret'),
  ];
}

/**
 * Reads the `data_path` of the catalog that the answers describe, once for the same catalog answers: the storage
 * question comes again after "Edit settings". Undefined when it cannot be read; the user is then asked without a proposal.
 */
export function dataPathReader(
  ui: WizardUi,
  dataPathOf: ((profile: ConnectionProfile, password?: string) => Promise<string | null>) | undefined,
  answers: Readonly<Record<'host' | 'port' | 'database' | 'user' | 'path' | 'ssl' | 'signIn', string>>,
  passwordOf: (profile: ConnectionProfile) => Promise<string | undefined>,
  profileOf: () => ConnectionProfile,
): () => Promise<string | null | undefined> {
  let read: { key: string; path: string | null | undefined } | undefined;
  return async () => {
    if (!dataPathOf) {
      return undefined;
    }
    const profile = profileOf();
    const password = await passwordOf(profile);
    const key = JSON.stringify([
      answers.host,
      answers.port,
      answers.database,
      answers.user,
      answers.path,
      answers.ssl,
      answers.signIn,
      password,
    ]);
    if (read?.key !== key) {
      let path: string | null | undefined;
      try {
        path = await ui.withProgress('Reading the data path of the catalog...', () =>
          dataPathOf(profile, password),
        );
      } catch {
        // The catalog is not reachable (yet): the storage is asked without a proposal; the test reports the reason.
        path = undefined;
      }
      read = { key, path };
    }
    return read.path;
  };
}

function proposeKind(family: string | undefined): StorageKindAnswer {
  switch (family) {
    case 's3':
      return 'aws';
    case 'r2':
      return 's3';
    case 'azure':
      return 'azure';
    case 'onelake':
      return 'onelake';
    default:
      return 'none';
  }
}

function currentFirst<T extends string>(items: readonly PickItem<T>[], current: string): PickItem<T>[] {
  return [
    ...items.filter(({ value }) => value === current),
    ...items.filter(({ value }) => value !== current),
  ];
}
