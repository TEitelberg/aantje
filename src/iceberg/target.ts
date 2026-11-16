import { isObject } from '../guards';

/** How aantje signs in to an Iceberg REST catalog. */
export type IcebergSignIn = 'oauth2' | 'token' | 'none';

/** An Iceberg REST catalog that a lake can be copied to. The secret (client secret or token) is never part of it. */
export interface IcebergTarget {
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

/** The secret of a target is a client secret (oauth2) or a token; `none` has no secret. */
export const usesSecret = (target: Pick<IcebergTarget, 'signIn'>): boolean => target.signIn !== 'none';
