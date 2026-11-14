import { locate } from '../storage/location';
import {
  CONNECTION_FIX,
  FAMILY_KINDS,
  FAMILY_LABEL,
  KIND_LABEL,
  SIGN_IN_FIX,
  familyOf,
  viaConnection,
} from './connection-facts';
import type { ConnectionFacts } from './connection-facts';
import { finding } from './finding';
import type { HealthFinding } from './model';

const LAKE_SCOPE = { kind: 'lake' } as const;

/** The checks of the storage of the connection against the data path: the kind, the account, the expiry, the sign-in. */
export function storageConfigFindings(facts: ConnectionFacts, now: Date): HealthFinding[] {
  return [...storageFindings(facts, now), ...credentialFindings(facts)];
}

function credentialFindings(facts: ConnectionFacts): HealthFinding[] {
  const { dataPath, credentials, storage } = facts;
  const family = familyOf(dataPath);
  if (dataPath === null || !(family in REMOTE_LABEL) || credentials !== undefined || kindMismatch(facts)) {
    return [];
  }
  if (!viaConnection(facts)) {
    // The machine's S3 settings and keys, as before.
    return [
      finding('connection.credentials-missing', {
        severity: 'warning',
        scope: LAKE_SCOPE,
        title: 'The lake is on S3 but aantje has no S3 credentials',
        detail: `data_path is "${dataPath}". No credentials are stored and the environment variables AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not both set. Only a bucket that allows anonymous reads works without them.`,
        cause: 'The command "aantje: Set S3 Credentials..." was never run on this machine.',
        fix: 'Run "aantje: Set S3 Credentials..." or set the environment variables for the extension host.',
        objectKey: dataPath,
      }),
    ];
  }
  const label = REMOTE_LABEL[family as keyof typeof REMOTE_LABEL];
  const publicNote =
    family === 's3' || family === 'r2'
      ? ' Only a bucket that allows anonymous reads works without a sign-in.'
      : '';
  return [
    finding('connection.credentials-missing', {
      severity: 'warning',
      scope: LAKE_SCOPE,
      title: `The lake is on ${label} but the connection has no sign-in for it`,
      detail:
        storage === undefined
          ? `data_path is "${dataPath}". The connection has no storage: aantje does not know how to sign in to ${label}.${publicNote}`
          : `data_path is "${dataPath}". The ${KIND_LABEL[storage.kind]} of the connection (sign-in "${storage.signIn}") has no keys, token or secret stored for it.${publicNote}`,
      cause:
        storage === undefined
          ? 'The connection was set up without a storage, or the catalog was moved to another storage after that.'
          : 'The sign-in was never entered on this machine, or the endpoint, the account or the sign-in of the storage was edited afterwards, which drops the stored values.',
      fix:
        storage === undefined
          ? 'Run "Edit Connection" and choose the storage that the data path names, with its sign-in.'
          : 'Run "Set Storage Sign-in..." on the connection and enter the values again, or Edit Connection to change the sign-in.',
      objectKey: dataPath,
      connectionActions: storage === undefined ? CONNECTION_FIX : SIGN_IN_FIX,
    }),
  ];
}

const REMOTE_LABEL = {
  s3: 'S3',
  r2: 'Cloudflare R2',
  azure: 'Azure storage',
  onelake: 'OneLake',
} as const;

// The storage is not the kind the data path names. A connection on the machine's S3 settings has no storage of its own.
function kindMismatch({ dataPath, storage }: ConnectionFacts): boolean {
  const kinds = FAMILY_KINDS[familyOf(dataPath)];
  return (
    storage !== undefined &&
    storage.legacy !== 'settings' &&
    kinds !== undefined &&
    !kinds.includes(storage.kind)
  );
}

function storageFindings(facts: ConnectionFacts, now: Date): HealthFinding[] {
  const { dataPath, storage } = facts;
  if (dataPath === null || storage === undefined || storage.legacy === 'settings') return [];
  const family = familyOf(dataPath);
  const findings: HealthFinding[] = [];
  if (kindMismatch(facts)) {
    findings.push(
      finding('connection.kind-mismatch', {
        severity: 'warning',
        scope: LAKE_SCOPE,
        title: 'The storage of the connection does not fit the data path of the catalog',
        detail: `data_path is "${dataPath}", which is ${FAMILY_LABEL[family]}, but the connection signs in to ${KIND_LABEL[storage.kind]}. The sign-in is not used for this path.`,
        cause: 'The storage was chosen for another lake, or the catalog now points to another storage.',
        fix: 'Run "Edit Connection" and choose the storage that the data path names.',
        objectKey: dataPath,
        connectionActions: CONNECTION_FIX,
      }),
    );
  }
  const written = locate(dataPath).account;
  if (
    storage.kind === 'azure' &&
    family === 'azure' &&
    written !== undefined &&
    storage.account !== undefined &&
    written !== storage.account.toLowerCase()
  ) {
    findings.push(
      finding('connection.account-mismatch', {
        severity: 'error',
        scope: LAKE_SCOPE,
        title: 'The data path names another storage account than the connection',
        detail: `data_path is "${dataPath}", on the storage account "${written}". The connection signs in to "${storage.account}", so the sign-in is not used for the data and the requests are refused.`,
        cause:
          'The account of the connection was edited, or the catalog was copied from a lake in another account.',
        fix: `Run "Edit Connection" and set the storage account to "${written}", or point the catalog to the account of the connection.`,
        objectKey: dataPath,
        connectionActions: CONNECTION_FIX,
      }),
    );
  }
  findings.push(...expiryFindings(facts, now));
  return findings;
}

const SOON_MS = 3 * 24 * 60 * 60_000;

function expiryFindings({ signInExpires, storage }: ConnectionFacts, now: Date): HealthFinding[] {
  if (signInExpires === undefined || storage === undefined) return [];
  const left = signInExpires - now.getTime();
  if (left > SOON_MS) return [];
  const on = new Date(signInExpires).toISOString();
  const expired = left <= 0;
  return [
    finding('connection.sign-in-expired', {
      severity: expired ? 'error' : 'warning',
      scope: LAKE_SCOPE,
      title: expired
        ? 'The shared access signature (SAS) of the storage has expired'
        : 'The shared access signature (SAS) of the storage expires soon',
      detail: `The SAS stored for the storage account "${storage.account ?? ''}" ${expired ? 'ran out' : 'runs out'} on ${on}.${expired ? ' Every request with it is refused.' : ''}`,
      cause: 'A SAS is valid only until the date that was chosen when it was created.',
      fix: 'Create a new SAS in the Azure portal (or with the CLI) and enter it with "Set Storage Sign-in...".',
      connectionActions: SIGN_IN_FIX,
    }),
  ];
}
