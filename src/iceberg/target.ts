import { isObject } from '../guards';
import { isGuid } from '../storage/config';

/**
 * How aantje signs in to an Iceberg REST catalog. `entra` is the Microsoft account of VS Code, for a Fabric lakehouse:
 * aantje stores no secret for it.
 */
export type IcebergSignIn = 'oauth2' | 'token' | 'none' | 'entra';

/** The Iceberg catalog of OneLake, which serves the lakehouses of Microsoft Fabric. */
export const FABRIC_ICEBERG_ENDPOINT = 'https://onelake.table.fabric.microsoft.com/iceberg';

/** A lakehouse of Microsoft Fabric, written through the Iceberg catalog of OneLake with the Microsoft account of VS Code. */
export interface FabricLakehouse {
  /** The ids (GUIDs) of the workspace and the lakehouse: they stay when either is renamed. */
  readonly workspace: string;
  readonly lakehouse: string;
  /** The names when the target was made, for messages. */
  readonly workspaceName?: string;
  readonly lakehouseName?: string;
  /** The Entra tenant of the sign-in; undefined: the tenant of the Microsoft account. */
  readonly tenant?: string;
  /** Whether the lakehouse has schemas; one without has only `dbo`. */
  readonly schemas: boolean;
}

/** An Iceberg REST catalog that a lake can be copied to. The secret (client secret or token) is never part of it. */
export interface IcebergTarget {
  /** Set for a Fabric lakehouse: then the endpoint is the one of OneLake and the sign-in is `entra`. */
  readonly fabric?: FabricLakehouse;
  readonly id: string;
  readonly name: string;
  /** The REST endpoint, for example `http://polaris:8181/api/catalog`. */
  readonly endpoint: string;
  /** The warehouse or catalog name that `ATTACH` takes. */
  readonly warehouse: string;
  readonly signIn: IcebergSignIn;
  /** OAuth2 only. */
  readonly clientId?: string;
  /** OAuth2 only; default: `<endpoint>/v1/oauth/tokens`. */
  readonly oauth2ServerUri?: string;
  /** OAuth2 only. */
  readonly scope?: string;
  /** For the storage that the catalog hands out credentials for; Polaris sends none for S3-compatible stores. */
  readonly region: string;
  /** Whether the catalog hands out short-lived storage credentials (`vended_credentials`). */
  readonly vendedCredentials: boolean;
}

export const DEFAULT_REGION = 'us-east-1';
const SIGN_INS: readonly IcebergSignIn[] = ['oauth2', 'token', 'none'];

export function validateEndpoint(value: string): string | undefined {
  const text = value.trim();
  if (!/^https?:\/\/[^\s/]+/i.test(text)) {
    return 'Enter the REST endpoint as a URL that starts with http:// or https://.';
  }
  return /\s/.test(text) ? 'The endpoint must not contain spaces.' : undefined;
}

export function oauth2ServerUriOf(target: Pick<IcebergTarget, 'endpoint' | 'oauth2ServerUri'>): string {
  return target.oauth2ServerUri ?? `${target.endpoint.replace(/\/+$/, '')}/v1/oauth/tokens`;
}

/** The first problem of an entry, as the reason it is skipped. */
function problemOf(entry: Record<string, unknown>): string | undefined {
  const text = (key: string): string | undefined => {
    const value = entry[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };
  if (!text('name')) return '"name" is required.';
  if (entry.kind === 'fabric') return fabricProblemOf(entry, text);
  if (entry.kind !== undefined && entry.kind !== 'rest') return '"kind" must be "rest" or "fabric".';
  const endpoint = text('endpoint');
  if (!endpoint || validateEndpoint(endpoint)) return '"endpoint" must be an http:// or https:// URL.';
  if (!text('warehouse')) return '"warehouse" is required.';
  if (!SIGN_INS.includes(entry.signIn as IcebergSignIn))
    return '"signIn" must be "oauth2", "token" or "none".';
  if (entry.signIn === 'oauth2' && !text('clientId')) return '"clientId" is required for oauth2.';
  if (
    entry.signIn !== 'oauth2' &&
    (entry.clientId !== undefined || entry.oauth2ServerUri !== undefined || entry.scope !== undefined)
  ) {
    return '"clientId", "oauth2ServerUri" and "scope" belong to "oauth2".';
  }
  if (entry.vendedCredentials !== undefined && typeof entry.vendedCredentials !== 'boolean') {
    return '"vendedCredentials" must be true or false.';
  }
  return undefined;
}

/** The first problem of a Fabric lakehouse entry: the ids are GUIDs, the tenant too when it is set. */
function fabricProblemOf(
  entry: Record<string, unknown>,
  text: (key: string) => string | undefined,
): string | undefined {
  if (!isGuid(text('workspace') ?? '')) return '"workspace" must be the id (a GUID) of the Fabric workspace.';
  if (!isGuid(text('lakehouse') ?? '')) return '"lakehouse" must be the id (a GUID) of the lakehouse.';
  if (entry.tenant !== undefined && !isGuid(text('tenant') ?? '')) return '"tenant" must be a GUID.';
  if (entry.schemas !== undefined && typeof entry.schemas !== 'boolean')
    return '"schemas" must be true or false.';
  return undefined;
}

/** Reads `aantje.icebergTargets`; an entry that breaks a rule is skipped and reported. */
export function parseTargets(raw: unknown): { targets: IcebergTarget[]; problems: string[] } {
  const targets: IcebergTarget[] = [];
  const problems: string[] = [];
  const entries = Array.isArray(raw) ? raw : [];
  entries.forEach((entry, index) => {
    const problem = !isObject(entry) ? 'The entry must be an object.' : problemOf(entry);
    if (problem || !isObject(entry)) {
      problems.push(`aantje.icebergTargets[${index}]: ${problem}`);
      return;
    }
    const str = (key: string): string | undefined =>
      typeof entry[key] === 'string' ? entry[key].trim() : undefined;
    const name = str('name') ?? '';
    const id = typeof entry.id === 'string' && entry.id.trim() !== '' ? entry.id.trim() : idOf(name, targets);
    if (targets.some((known) => known.id === id || known.name.toLowerCase() === name.toLowerCase())) {
      problems.push(`aantje.icebergTargets[${index}]: the name or id is used by an earlier entry.`);
      return;
    }
    const optional = (key: string): Record<string, string> => {
      const value = str(key);
      return value ? { [key]: value } : {};
    };
    if (entry.kind === 'fabric') {
      targets.push(
        fabricTarget(id, name, {
          workspace: (str('workspace') ?? '').toLowerCase(),
          lakehouse: (str('lakehouse') ?? '').toLowerCase(),
          ...optional('workspaceName'),
          ...optional('lakehouseName'),
          ...optional('tenant'),
          schemas: entry.schemas !== false,
        }),
      );
      return;
    }
    targets.push({
      id,
      name,
      endpoint: (str('endpoint') ?? '').replace(/\/+$/, ''),
      warehouse: str('warehouse') ?? '',
      signIn: entry.signIn as IcebergSignIn,
      ...optional('clientId'),
      ...optional('oauth2ServerUri'),
      ...optional('scope'),
      region: nonEmpty(str('region')) ?? DEFAULT_REGION,
      vendedCredentials: entry.vendedCredentials !== false,
    });
  });
  return { targets, problems };
}

const nonEmpty = (value: string | undefined): string | undefined => (value === '' ? undefined : value);

/**
 * The target of a Fabric lakehouse: the Iceberg catalog of OneLake, where the warehouse is `<workspace>/<lakehouse>`.
 * The storage is OneLake itself, which aantje signs in to with the same Microsoft account (no vended credentials).
 */
export function fabricTarget(id: string, name: string, fabric: FabricLakehouse): IcebergTarget {
  return {
    id,
    name,
    fabric,
    endpoint: FABRIC_ICEBERG_ENDPOINT,
    warehouse: `${fabric.workspace}/${fabric.lakehouse}`,
    signIn: 'entra',
    region: DEFAULT_REGION,
    vendedCredentials: false,
  };
}

/**
 * Where the target writes, in words: `warehouse at endpoint`, or the lakehouse and the workspace of Fabric with its ID,
 * so that the user finds it among workspaces of the same name.
 */
export function targetPlace(target: IcebergTarget): string {
  const { fabric } = target;
  if (!fabric) return `${target.warehouse} at ${target.endpoint}`;
  const workspace =
    fabric.workspaceName === undefined
      ? `WorkspaceID "${fabric.workspace}"`
      : `Workspace "${fabric.workspaceName}" with WorkspaceID "${fabric.workspace}"`;
  return `Fabric lakehouse "${fabric.lakehouseName ?? fabric.lakehouse}" in ${workspace}`;
}

/** The id of a new target: the name as a slug, with a number when it is taken. */
export function idOf(name: string, taken: readonly Pick<IcebergTarget, 'id'>[]): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'target';
  let id = slug;
  for (let n = 2; taken.some((target) => target.id === id); n++) id = `${slug}-${n}`;
  return id;
}

/** An explicit field list: nothing else that the object carries may reach the setting. */
export function toSettingEntry(target: IcebergTarget): Record<string, unknown> {
  if (target.fabric) {
    const { workspace, lakehouse, workspaceName, lakehouseName, tenant, schemas } = target.fabric;
    return {
      id: target.id,
      name: target.name,
      kind: 'fabric',
      workspace,
      lakehouse,
      ...(workspaceName === undefined ? {} : { workspaceName }),
      ...(lakehouseName === undefined ? {} : { lakehouseName }),
      ...(tenant === undefined ? {} : { tenant }),
      schemas,
    };
  }
  const {
    id,
    name,
    endpoint,
    warehouse,
    signIn,
    clientId,
    oauth2ServerUri,
    scope,
    region,
    vendedCredentials,
  } = target;
  return {
    id,
    name,
    endpoint,
    warehouse,
    signIn,
    ...(clientId === undefined ? {} : { clientId }),
    ...(oauth2ServerUri === undefined ? {} : { oauth2ServerUri }),
    ...(scope === undefined ? {} : { scope }),
    region,
    vendedCredentials,
  };
}

/**
 * Whether aantje stores a secret for the target: a client secret (oauth2) or a token. `none` has none, and `entra` signs
 * in with the Microsoft account of VS Code each time.
 */
export const usesSecret = (target: Pick<IcebergTarget, 'signIn'>): boolean =>
  target.signIn !== 'none' && target.signIn !== 'entra';
