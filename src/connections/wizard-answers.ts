// The answers of the connection wizard and how they map to a profile and back: what Add Connection starts with, what
// Edit Connection prefills from the profile, and the profile that the answers describe.
import type { StoredValueName } from '../storage/config';
import { fileRootsAnswer, fileRootsOf } from './file-roots';
import type { ConnectionKind, ConnectionProfile, PostgresProfile } from './profile';
import { DEFAULT_PORT, DEFAULT_QUACK_PORT, effectiveStorage } from './profile';
import { blankStorageAnswers, sameStorage, storageAnswersOf, storageOf } from './storage-steps';
import type { StorageField } from './storage-steps';

export type Field =
  | 'name'
  | 'host'
  | 'port'
  | 'database'
  | 'signIn'
  | 'tenant'
  | 'iamProfile'
  | 'user'
  | 'ssl'
  | 'fingerprint'
  | 'path'
  | 'password'
  | 'readOnly'
  | 'fileRoots'
  | StorageField
  | StoredValueName;
export type Answers = Record<Field, string>;

/** The answer of the fingerprint step that pins nothing: the certificate is checked against the system trust store. */
export const SYSTEM_TRUST = '';

/** The sign-in to PostgreSQL that the wizard offers: a password, a Microsoft Entra token or an AWS IAM token. */
export type SignInMode = 'password' | 'entra' | 'aws';

/** Whether the answers sign in with a token (Entra or AWS IAM), which leaves no password to type or keep. */
export const signsInWithTokenAnswer = (answers: Answers): boolean =>
  answers.signIn === 'entra' || answers.signIn === 'aws';

/** The password typed in the wizard; a token login has none, also not one typed before the sign-in was switched. */
export function typedPasswordOf(answers: Answers): string | undefined {
  return signsInWithTokenAnswer(answers) ? undefined : answers.password || undefined;
}

/** The answers the wizard starts with: blank for a new connection of `kind`, else those of the edited profile. */
export function initialAnswers(kind: ConnectionKind, existing: ConnectionProfile | undefined): Answers {
  const blank: Answers = {
    name: '',
    host: '',
    port: String(kind === 'quack' ? DEFAULT_QUACK_PORT : DEFAULT_PORT),
    database: '',
    signIn: 'password',
    tenant: '',
    iamProfile: '',
    user: '',
    ssl: 'no',
    fingerprint: SYSTEM_TRUST,
    path: '',
    password: '',
    readOnly: 'no',
    fileRoots: fileRootsAnswer(existing),
    ...blankStorageAnswers(),
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
        signIn: existing.awsAuth === 'iam' ? 'aws' : (existing.azureAuth ?? 'password'),
        tenant: existing.azureTenant ?? '',
        iamProfile: existing.awsProfile ?? '',
        user: existing.user,
        ssl: existing.ssl ? 'yes' : 'no',
        readOnly: existing.readOnly ? 'yes' : 'no',
        ...storageAnswersOf(effectiveStorage(existing)),
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
        ...storageAnswersOf(effectiveStorage(existing)),
      };
  }
}

/** The profile that the answers describe. `metadataSchema` is not asked for; it is carried over from the edited profile. */
export function toProfile(
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
  const asked = storageOf(answers);
  const storage = asked === undefined ? {} : { storage: asked };
  const fileRoots = fileRootsOf(existing, answers.fileRoots);
  if (kind !== 'postgres') {
    return { id, name: answers.name, kind, path: answers.path, ...storage, ...fileRoots, ...readOnly };
  }
  const previous = existing?.kind === 'postgres' ? existing : undefined;
  // A profile with the legacy `azureAccount` stays as it is while its storage answers describe the same storage; the
  // first change of the storage writes `storage` and drops `azureAccount`.
  const legacy =
    previous?.azureAccount !== undefined && sameStorage(asked, effectiveStorage(previous))
      ? { azureAccount: previous.azureAccount }
      : {};
  const aws = answers.signIn === 'aws';
  return {
    id,
    name: answers.name,
    kind,
    host: answers.host,
    port: Number(answers.port),
    database: answers.database,
    user: answers.user,
    // RDS takes an IAM token only over TLS.
    ssl: aws || answers.ssl === 'yes',
    ...readOnly,
    ...(previous?.metadataSchema === undefined ? {} : { metadataSchema: previous.metadataSchema }),
    // `azureAccount` and `storage` exclude each other.
    ...(legacy.azureAccount === undefined ? storage : legacy),
    ...fileRoots,
    ...signInOf(answers, legacy.azureAccount !== undefined),
  };
}

/** The sign-in to PostgreSQL that the answers describe: the fields of Entra or of AWS IAM, none for a password. */
function signInOf(
  answers: Answers,
  legacyAccount: boolean,
): Pick<PostgresProfile, 'azureTenant' | 'azureAuth' | 'awsAuth' | 'awsProfile'> {
  const entra = answers.signIn === 'entra';
  const iamProfile = answers.iamProfile.trim();
  return {
    // The tenant of the PostgreSQL token; the legacy account is read in the same tenant.
    ...((entra || legacyAccount) && answers.tenant !== '' ? { azureTenant: answers.tenant } : {}),
    ...(entra ? { azureAuth: 'entra' as const } : {}),
    ...(answers.signIn === 'aws'
      ? { awsAuth: 'iam' as const, ...(iamProfile === '' ? {} : { awsProfile: iamProfile }) }
      : {}),
  };
}
