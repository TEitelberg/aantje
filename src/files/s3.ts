import type { AwsStorage, S3Storage } from '../storage/config';
import { dateOf, element, elements, get, refusal, sizeOf } from './http';
import type { Http, RawEntry, RawLevel } from './http';
import { canonicalQuery, signedHeaders } from './sigv4';
import type { S3Keys } from './sigv4';

// One level of an S3 bucket: ListObjectsV2 with the delimiter `/`, so the store answers with the keys of the level and
// one prefix per folder, never with the keys below. The request goes to the endpoint of the connection's storage, the
// way the engine addresses it (path or virtual-host style), and is signed with the storage's keys when it has some.

/** Where the requests of one storage go and how they are signed. */
export interface S3Target {
  /** `https://host[:port]`, without a path. */
  readonly origin: string;
  readonly region: string;
  /** The bucket in the path (`origin/bucket`) instead of the host (`bucket.host`). */
  readonly pathStyle: boolean;
  readonly keys?: S3Keys;
  /** Amazon S3 itself: a bucket in another region answers with that region, and the request is made once more there. */
  readonly aws: boolean;
}

const PAGE = 1000;
// A bucket name that is also a safe DNS label; any other name goes into the path, never into the host.
const DNS_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const DEFAULT_REGION = 'us-east-1';

function awsTarget(region: string | undefined, keys: S3Keys | undefined): S3Target {
  const name = region ?? DEFAULT_REGION;
  return {
    origin: `https://s3.${name}.amazonaws.com`,
    region: name,
    pathStyle: false,
    aws: true,
    ...withKeys(keys),
  };
}

const withKeys = (keys: S3Keys | undefined): { keys?: S3Keys } => (keys === undefined ? {} : { keys });

/**
 * The target of a storage, as the DuckDB secret of the storage addresses it: AWS by region (also the global S3
 * settings without an endpoint), R2 by account, any other store by its endpoint, with the virtual-host style that
 * DuckDB uses unless the storage says `path`.
 */
export function s3TargetOf(config: AwsStorage | S3Storage, keys: S3Keys | undefined): S3Target {
  if (config.kind === 'aws') {
    return awsTarget(config.region, keys);
  }
  if (config.accountId !== undefined) {
    return {
      origin: `https://${config.accountId}.r2.cloudflarestorage.com`,
      region: 'auto',
      pathStyle: true,
      aws: false,
      ...withKeys(keys),
    };
  }
  const endpoint = config.endpoint?.trim() ?? '';
  if (endpoint === '') {
    return awsTarget(config.region, keys);
  }
  const match = /^(https?):\/\/(.*)$/i.exec(endpoint);
  const host = (match?.[2] ?? endpoint).replace(/\/+$/, '');
  return {
    origin: `${match?.[1]?.toLowerCase() ?? 'https'}://${host}`,
    region: config.region ?? DEFAULT_REGION,
    pathStyle: config.urlStyle === 'path',
    aws: false,
    ...withKeys(keys),
  };
}

/** The URL of a listing request. */
function listingUrl(target: S3Target, bucket: string, query: string): URL {
  const origin = new URL(target.origin);
  if (target.pathStyle || !DNS_BUCKET.test(bucket)) {
    return new URL(`${origin.origin}/${encodeURIComponent(bucket)}?${query}`);
  }
  return new URL(`${origin.protocol}//${bucket}.${origin.host}/?${query}`);
}

// With `encoding-type=url` the store writes keys url-encoded (a key may hold characters that XML cannot carry); a
// space may come as `+`, so a `+` of the key itself is always `%2B`.
function decodeKey(text: string): string {
  try {
    return decodeURIComponent(text.replaceAll('+', ' '));
  } catch {
    return text;
  }
}

interface Page {
  readonly entries: RawEntry[];
  readonly next?: string;
}

function parsePage(xml: string, prefix: string): Page {
  const entries: RawEntry[] = [];
  for (const block of elements(xml, 'CommonPrefixes')) {
    const key = decodeKey(element(block, 'Prefix') ?? '');
    if (key.length > prefix.length) entries.push({ key: key.replace(/\/$/, ''), folder: true });
  }
  for (const block of elements(xml, 'Contents')) {
    const key = decodeKey(element(block, 'Key') ?? '');
    // The empty object that some tools write for a folder is the level itself, or a folder with a prefix entry too.
    if (key === prefix || key.endsWith('/')) continue;
    const size = sizeOf(element(block, 'Size'));
    const modified = dateOf(element(block, 'LastModified'));
    entries.push({
      key,
      folder: false,
      ...(size === undefined ? {} : { size }),
      ...(modified === undefined ? {} : { modified }),
    });
  }
  const truncated = element(xml, 'IsTruncated')?.trim() === 'true';
  const next = element(xml, 'NextContinuationToken');
  return { entries, ...(truncated && next ? { next } : {}) };
}

export interface ListOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

async function requestPage(
  http: Http,
  target: S3Target,
  bucket: string,
  params: Record<string, string>,
  options: ListOptions,
): Promise<{ status: number; body: string; region?: string }> {
  const url = listingUrl(target, bucket, canonicalQuery(params));
  const headers = target.keys
    ? signedHeaders(url, target.region, target.keys, options.now?.() ?? new Date())
    : {};
  const response = await get(http, url.toString(), headers, options);
  const region = response.headers.get('x-amz-bucket-region') ?? undefined;
  return { status: response.status, body: await response.text(), ...(region ? { region } : {}) };
}

/**
 * The entries of one level below `prefix` (`''` or ending in `/`) of `bucket`, page by page, until all are read or
 * `ceiling` entries are; a refusal throws with the store's code and message.
 */
export async function listS3Level(
  http: Http,
  start: S3Target,
  bucket: string,
  prefix: string,
  ceiling: number,
  options: ListOptions = {},
): Promise<RawLevel> {
  let target = start;
  const entries: RawEntry[] = [];
  let token: string | undefined;
  do {
    const params: Record<string, string> = {
      'list-type': '2',
      delimiter: '/',
      'encoding-type': 'url',
      'max-keys': String(PAGE),
      prefix,
      ...(token === undefined ? {} : { 'continuation-token': token }),
    };
    let answer = await requestPage(http, target, bucket, params, options);
    if (target.aws && answer.status !== 200 && answer.region && answer.region !== target.region) {
      target = awsTarget(answer.region, target.keys);
      answer = await requestPage(http, target, bucket, params, options);
    }
    if (answer.status !== 200) {
      throw refusal(answer.status, element(answer.body, 'Code'), element(answer.body, 'Message'));
    }
    const page = parsePage(answer.body, prefix);
    entries.push(...page.entries);
    token = page.next;
  } while (token !== undefined && entries.length < ceiling);
  return { entries: entries.slice(0, ceiling), cut: token !== undefined || entries.length > ceiling };
}
