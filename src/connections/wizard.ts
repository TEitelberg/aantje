import type { CatalogInfo } from '../catalog/model';
import { userMessageOf } from '../errors';
import type { PickItem, WizardUi } from './ports';
import type { AzureAuthMode, ConnectionKind, ConnectionProfile } from './profile';
import {
  connectionTarget,
  DEFAULT_PORT,
  DEFAULT_QUACK_PORT,
  defaultSsl,
  isAzurePostgresHost,
  isNameTaken,
  secretLabel,
  usesSecret,
  validateHost,
  validatePath,
  validatePort,
  validateQuackHost,
  validateRequired,
  validateStorageAccount,
  validateTenant,
} from './profile';
import type { ConnectionStore } from './store';

export interface WizardDeps {
  readonly store: ConnectionStore;
  /** Opens the catalog and reads its info; rejects with an `AantjeError` when it cannot be used. */
  testConnection(profile: ConnectionProfile, password?: string): Promise<CatalogInfo>;
  /** The SHA-256 fingerprint of the certificate that a TLS server presents, read without checking it. */
  certificateFingerprint(host: string, port: number): Promise<string>;
  /** The sign-in name of the Microsoft account of the editor, the Entra user on PostgreSQL; signs in if needed. */
  readonly entraUser?: (tenant: string | undefined) => Promise<string>;
}

type Field =
  | 'name'
  | 'host'
  | 'port'
  | 'database'
  | 'signIn'
  | 'storage'
  | 'tenant'
  | 'user'
  | 'ssl'
  | 'fingerprint'
  | 'path'
  | 'password'
  | 'readOnly';
type Answers = Record<Field, string>;

interface Step {
  readonly field: Field;
  /** What the input asks; a function when the words depend on the earlier answers. */
  readonly prompt: string | ((answers: Answers) => string);
  readonly validate?: (value: string) => string | undefined;
  readonly password?: boolean;
  readonly choices?: readonly PickItem<string>[];
  /** Asks in its own way instead of an input or a pick; undefined cancels the flow. */
  readonly ask?: (heading: string, answers: Answers) => Promise<string | undefined>;
  /** The step does not apply to these answers and is not asked. */
  readonly skip?: (answers: Answers) => boolean;
}

const KIND_ITEMS: readonly PickItem<ConnectionKind>[] = [
  { label: 'PostgreSQL', description: 'Catalog stored in a PostgreSQL database', value: 'postgres' },
  { label: 'SQLite', description: 'Catalog stored in a SQLite database file', value: 'sqlite' },
  { label: 'DuckDB', description: 'Catalog stored in a DuckDB database file', value: 'duckdb' },
  {
    label: 'DuckDB + Quack',
    description: 'Catalog served by a DuckDB server over the Quack protocol',
    value: 'quack',
  },
];

const TLS_ITEMS: readonly PickItem<'no' | 'yes'>[] = [
  { label: 'No', description: 'Unencrypted; only for localhost or a trusted network', value: 'no' },
  { label: 'Yes', description: 'Encrypted; the server certificate must be trusted', value: 'yes' },
];

const READ_ONLY_ITEMS: readonly PickItem<'no' | 'yes'>[] = [
  { label: 'No', description: 'Writable session: runs any statement the credentials allow', value: 'no' },
  { label: 'Yes', description: 'Read-only session: refuses statements that change the lake', value: 'yes' },
];

const SIGN_IN_ITEMS: readonly PickItem<AzureAuthMode>[] = [
  {
    label: 'Password',
    description: 'A user name and a password, kept in the secret storage',
    value: 'password',
  },
  {
    label: 'Microsoft Entra ID',
    description: 'Your Microsoft account signs in with a token for every connection; no password is stored',
    value: 'entra',
  },
];

const AFTER_FAILURE: readonly PickItem<'save' | 'edit' | 'cancel'>[] = [
  { label: 'Save anyway', description: 'Keep the connection although the test failed', value: 'save' },
  { label: 'Edit settings', description: 'Go back and change the values', value: 'edit' },
  { label: 'Cancel', description: 'Discard the connection', value: 'cancel' },
];

// The answer of the fingerprint step that pins nothing: the certificate is checked against the system trust store.
const SYSTEM_TRUST = '';

/** Asks for the kind and the connection details, tests the connection and saves it. Undefined when cancelled. */
export async function addConnectionFlow(
  ui: WizardUi,
  deps: WizardDeps,
): Promise<ConnectionProfile | undefined> {
  const kind = await ui.pick('Add Connection: where is the DuckLake metadata stored?', KIND_ITEMS);
  return kind === undefined ? undefined : configure(ui, deps, kind);
}

/** Same questions as when adding, prefilled; an empty password keeps the stored one. */
export function editConnectionFlow(
  ui: WizardUi,
  profile: ConnectionProfile,
  deps: WizardDeps,
): Promise<ConnectionProfile | undefined> {
  return configure(ui, deps, profile.kind, profile);
}

/** Returns whether the connection was removed. */
export async function removeConnectionFlow(
  ui: WizardUi,
  profile: ConnectionProfile,
  deps: WizardDeps,
): Promise<boolean> {
  const confirmed = await ui.confirm(
    // A file connection keeps no secret, so its question names none.
    `Remove the connection "${profile.name}"? ${usesSecret(profile) ? `A stored ${secretLabel(profile)} is deleted too; the` : 'The'} catalog itself is not touched.`,
    'Remove',
  );
  if (confirmed) {
    await deps.store.remove(profile.id);
  }
  return confirmed;
}

async function configure(
  ui: WizardUi,
  deps: WizardDeps,
  kind: ConnectionKind,
  existing?: ConnectionProfile,
): Promise<ConnectionProfile | undefined> {
  const steps = stepsFor(kind, existing, ui, deps);
  const answers = initialAnswers(kind, existing);
  // A writable session locks a DuckDB file exclusively, so a new DuckDB connection starts read-only.
  if (!existing && kind === 'duckdb') {
    answers.readOnly = 'yes';
  }
  const ssl = { asked: existing !== undefined };
  const title = existing ? `Edit Connection "${existing.name}"` : 'Add Connection';

  for (;;) {
    if (!(await ask(ui, steps, answers, title, ssl))) {
      return undefined;
    }

    const profile = toProfile(existing?.id ?? deps.store.newId(answers.name), kind, answers, existing);
    // An Entra login has no password, also not one typed before the sign-in was switched in an earlier round.
    const entra = answers.signIn === 'entra';
    const typedPassword = entra ? undefined : answers.password || undefined;
    deps.store.registerPassword(typedPassword);
    // The stored password is reused only when it belongs to the edited target: if the host, port, database or user
    // changed, `password` returns undefined, so the test (and the save) do not send the old server's password to the new
    // one. The empty field then tests without a password; the password prompt says so.
    const password = entra ? undefined : (typedPassword ?? (await deps.store.password(profile)));
    let info: CatalogInfo | undefined;
    try {
      info = await ui.withProgress(`Testing connection "${profile.name}"...`, () =>
        deps.testConnection(profile, password),
      );
    } catch (error) {
      ui.error(`Connection test failed: ${userMessageOf(error)}`);
      const choice = await ui.pick('The connection test failed', AFTER_FAILURE);
      if (choice === 'edit') {
        continue;
      }
      if (choice !== 'save') {
        return undefined;
      }
    }

    await (existing ? deps.store.update(profile, typedPassword) : deps.store.add(profile, typedPassword));
    if (info) {
      ui.info(
        `Saved connection "${profile.name}". DuckLake spec version ${info.specVersion}, latest snapshot ${info.latestSnapshot}.`,
      );
    }
    return profile;
  }
}

async function ask(
  ui: WizardUi,
  steps: readonly Step[],
  answers: Answers,
  title: string,
  ssl: { asked: boolean },
): Promise<boolean> {
  for (const step of steps) {
    if (step.skip?.(answers)) {
      continue;
    }
    // Until the TLS question is answered, the certificate step counts, as it does for every host but the local one.
    const asked = steps.filter(
      (candidate) => !candidate.skip?.(answers) || (!ssl.asked && candidate.field === 'fingerprint'),
    );
    const heading = `${title} (${asked.indexOf(step) + 1}/${asked.length})`;
    // Only the first time and only for a new connection: the answer depends on the host that was just typed.
    if (step.field === 'ssl' && !ssl.asked) {
      answers.ssl = defaultSsl(answers.host) ? 'yes' : 'no';
      ssl.asked = true;
    }
    const current = answers[step.field];
    const prompt = typeof step.prompt === 'function' ? step.prompt(answers) : step.prompt;
    const value = step.ask
      ? await step.ask(heading, answers)
      : step.choices
        ? await ui.pick(`${heading}: ${prompt}`, currentFirst(step.choices, current))
        : await ui.input({
            title: heading,
            prompt,
            value: current,
            password: step.password,
            validate: step.validate,
          });
    if (value === undefined) {
      return false;
    }
    answers[step.field] = step.password ? value : value.trim();
  }
  return true;
}

function stepsFor(
  kind: ConnectionKind,
  existing: ConnectionProfile | undefined,
  ui: WizardUi,
  deps: WizardDeps,
): Step[] {
  const others = deps.store.list();
  const name: Step = {
    field: 'name',
    prompt: 'Name shown in the explorer',
    validate: (value) =>
      validateRequired('Name')(value) ??
      (isNameTaken(value, others, existing?.id) ? 'A connection with this name already exists.' : undefined),
  };
  if (kind === 'quack') {
    return [
      name,
      {
        field: 'host',
        prompt:
          'Host name or IP address of the DuckDB server that serves the catalog over Quack. The local machine is reached without TLS by default, every other host with TLS.',
        validate: validateQuackHost,
      },
      { field: 'port', prompt: 'Port of the Quack server', validate: validatePort },
      { field: 'ssl', prompt: 'Use TLS for the connection?', choices: TLS_ITEMS },
      {
        field: 'fingerprint',
        prompt: 'Certificate of the server',
        ask: (heading, answers) => askFingerprint(ui, deps, heading, answers),
        skip: (answers) => answers.ssl !== 'yes',
      },
      {
        field: 'password',
        prompt: existing
          ? 'Token (leave empty to keep the stored token)'
          : 'Token of the Quack server. It is kept in the secret storage, not in the settings.',
        password: true,
        validate: existing ? undefined : validateRequired('Token'),
      },
    ];
  }
  if (kind !== 'postgres') {
    const file = kind === 'sqlite' ? 'SQLite' : 'DuckDB';
    return [
      name,
      {
        field: 'path',
        prompt: `Path of the ${file} file that holds the DuckLake metadata`,
        validate: validatePath,
      },
      readOnlyStep(kind),
    ];
  }
  // The sign-in the user name was last answered for: switching to Entra prefills the name of the Microsoft account once.
  const userAnswered = {
    for: existing?.kind === 'postgres' ? (existing.azureAuth ?? 'password') : undefined,
  };
  const storedPassword = existing?.kind === 'postgres' && existing.azureAuth !== 'entra';
  // The stored password belongs to the server it was saved for: after the host, port, database or user changed, the
  // empty field would not keep it.
  const passwordPrompt = (answers: Answers): string => {
    if (!storedPassword) {
      return 'Password (leave empty if the server needs none). It is kept in the secret storage, not in the settings.';
    }
    const moved =
      connectionTarget(toProfile(existing.id, kind, answers, existing)) !== connectionTarget(existing);
    return moved
      ? 'Password of the new server. The stored password belongs to the previous server and is not reused; leave empty if the server needs none.'
      : 'Password (leave empty to keep the stored password)';
  };
  return [
    name,
    { field: 'host', prompt: 'Host name or IP address of the PostgreSQL server', validate: validateHost },
    { field: 'port', prompt: 'Port of the PostgreSQL server', validate: validatePort },
    {
      field: 'database',
      prompt: 'Database that holds the DuckLake metadata',
      validate: validateRequired('Database'),
    },
    { field: 'signIn', prompt: 'How do you sign in to PostgreSQL?', choices: SIGN_IN_ITEMS },
    {
      field: 'storage',
      prompt:
        'Storage account of the data files on Azure (abfss:// or az://), read with your Microsoft account. Leave empty if the data files are elsewhere.',
      validate: validateStorageAccount,
      skip: (answers) => !usesMicrosoftAccount(answers),
    },
    {
      field: 'tenant',
      prompt:
        'Directory (tenant) ID to sign in to with your Microsoft account. Leave empty for the home tenant of the account.',
      validate: validateTenant,
      skip: (answers) => !usesMicrosoftAccount(answers),
    },
    {
      field: 'user',
      prompt: 'User name',
      ask: async (heading, answers) => {
        const entra = answers.signIn === 'entra';
        if (entra && userAnswered.for !== 'entra') {
          answers.user = (await signedInUser(ui, deps, answers.tenant)) ?? answers.user;
        }
        const user = await ui.input({
          title: heading,
          prompt: entra
            ? 'Entra user name: the Microsoft Entra principal that is a role on the server, prefilled with your Microsoft account'
            : 'User name',
          value: answers.user,
          validate: validateRequired('User'),
        });
        userAnswered.for = answers.signIn as AzureAuthMode;
        return user;
      },
    },
    { field: 'ssl', prompt: 'Use TLS for the connection?', choices: TLS_ITEMS },
    {
      field: 'password',
      prompt: passwordPrompt,
      password: true,
      skip: (answers) => answers.signIn === 'entra',
    },
    readOnlyStep(kind),
  ];
}

// The Microsoft account signs in to PostgreSQL with Entra, and reads data files on Azure; an Azure server usually has both.
function usesMicrosoftAccount(answers: Answers): boolean {
  return answers.signIn === 'entra' || answers.storage !== '' || isAzurePostgresHost(answers.host);
}

/** The sign-in name of the Microsoft account, or undefined when it cannot be read; the user then types the name. */
async function signedInUser(ui: WizardUi, deps: WizardDeps, tenant: string): Promise<string | undefined> {
  const { entraUser } = deps;
  if (!entraUser) {
    return undefined;
  }
  try {
    return await ui.withProgress('Signing in with your Microsoft account...', () =>
      entraUser(tenant === '' ? undefined : tenant),
    );
  } catch (error) {
    ui.error(userMessageOf(error));
    return undefined;
  }
}

/**
 * Trust on first use: reads the certificate that the server presents and pins its fingerprint once the user has
 * compared and confirmed it. A certificate that matches the pinned one is kept without a question. The system trust
 * store is the choice for a certificate from a CA. Undefined cancels the flow.
 */
async function askFingerprint(
  ui: WizardUi,
  deps: WizardDeps,
  heading: string,
  answers: Answers,
): Promise<string | undefined> {
  const pinned = answers.fingerprint;
  const server = `${answers.host}:${answers.port}`;
  let presented: string | undefined;
  try {
    presented = await ui.withProgress(`Reading the TLS certificate of ${server}...`, () =>
      deps.certificateFingerprint(answers.host, Number(answers.port)),
    );
  } catch (error) {
    ui.error(userMessageOf(error));
  }
  if (presented !== undefined && presented === pinned) {
    return pinned;
  }
  if (presented !== undefined) {
    const changed = pinned === SYSTEM_TRUST ? '' : 'This is not the certificate that is pinned now. ';
    const trusted = await ui.confirm(
      `The server ${server} presents a certificate with the SHA-256 fingerprint\n\n${presented}\n\n${changed}Compare it with the fingerprint of the certificate on the server (openssl x509 -noout -fingerprint -sha256 -in <certificate>) before you trust it. aantje then accepts this certificate only, from this server.`,
      'Trust This Certificate',
    );
    if (trusted) {
      return presented;
    }
  }
  const items: PickItem<string>[] = [
    ...(pinned === SYSTEM_TRUST
      ? []
      : [{ label: 'Keep the pinned certificate', description: pinned, value: pinned }]),
    {
      label: 'Use the system trust store',
      description: 'For a certificate from a CA that this machine trusts',
      value: SYSTEM_TRUST,
    },
  ];
  return ui.pick(`${heading}: how should aantje check the certificate of ${server}?`, items);
}

function readOnlyStep(kind: ConnectionKind): Step {
  const warning =
    kind === 'duckdb'
      ? ' A writable session locks the DuckDB file exclusively, so the explorer cannot read it while the editor has it open.'
      : '';
  return {
    field: 'readOnly',
    prompt: `Open SQL editor sessions read-only?${warning}`,
    choices: READ_ONLY_ITEMS,
  };
}

function initialAnswers(kind: ConnectionKind, existing: ConnectionProfile | undefined): Answers {
  const blank: Answers = {
    name: '',
    host: '',
    port: String(kind === 'quack' ? DEFAULT_QUACK_PORT : DEFAULT_PORT),
    database: '',
    signIn: 'password',
    storage: '',
    tenant: '',
    user: '',
    ssl: 'no',
    fingerprint: SYSTEM_TRUST,
    path: '',
    password: '',
    readOnly: 'no',
  };
  if (!existing) {
    return blank;
  }
  switch (existing.kind) {
    case 'postgres':
      return {
        ...blank,
        name: existing.name,
        host: existing.host,
        port: String(existing.port),
        database: existing.database,
        signIn: existing.azureAuth ?? 'password',
        storage: existing.azureAccount ?? '',
        tenant: existing.azureTenant ?? '',
        user: existing.user,
        ssl: existing.ssl ? 'yes' : 'no',
        readOnly: existing.readOnly ? 'yes' : 'no',
      };
    case 'quack':
      return {
        ...blank,
        name: existing.name,
        host: existing.host,
        port: String(existing.port),
        ssl: existing.ssl ? 'yes' : 'no',
        fingerprint: existing.fingerprint ?? SYSTEM_TRUST,
      };
    default:
      return {
        ...blank,
        name: existing.name,
        path: existing.path,
        readOnly: existing.readOnly ? 'yes' : 'no',
      };
  }
}

function currentFirst(items: readonly PickItem<string>[], current: string): PickItem<string>[] {
  return [
    ...items.filter(({ value }) => value === current),
    ...items.filter(({ value }) => value !== current),
  ];
}

// `metadataSchema` is not asked for; it is carried over from the profile being edited.
function toProfile(
  id: string,
  kind: ConnectionKind,
  answers: Answers,
  existing: ConnectionProfile | undefined,
): ConnectionProfile {
  if (kind === 'quack') {
    const ssl = answers.ssl === 'yes';
    const fingerprint =
      ssl && answers.fingerprint !== SYSTEM_TRUST ? { fingerprint: answers.fingerprint } : {};
    return {
      id,
      name: answers.name,
      kind,
      host: answers.host,
      port: Number(answers.port),
      ssl,
      ...fingerprint,
    };
  }
  const readOnly = answers.readOnly === 'yes' ? { readOnly: true } : {};
  if (kind !== 'postgres') {
    return { id, name: answers.name, kind, path: answers.path, ...readOnly };
  }
  const previous = existing?.kind === 'postgres' ? existing : undefined;
  // A skipped question leaves its prefilled value, so only what the Microsoft account is used for is saved.
  const microsoft = usesMicrosoftAccount(answers);
  return {
    id,
    name: answers.name,
    kind,
    host: answers.host,
    port: Number(answers.port),
    database: answers.database,
    user: answers.user,
    ssl: answers.ssl === 'yes',
    ...readOnly,
    ...(previous?.metadataSchema === undefined ? {} : { metadataSchema: previous.metadataSchema }),
    ...(microsoft && answers.storage !== '' ? { azureAccount: answers.storage } : {}),
    ...(microsoft && answers.tenant !== '' ? { azureTenant: answers.tenant } : {}),
    ...(answers.signIn === 'entra' ? { azureAuth: 'entra' as const } : {}),
  };
}
