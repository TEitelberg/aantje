import { createHash, createHmac } from 'node:crypto';

// AWS Signature Version 4 for one GET request to S3, with node:crypto only. The listing of the Files folder signs with
// the keys that the storage of the connection holds; nothing else is signed with them.

/** The keys a request is signed with: the same values the DuckDB secret of the storage gets. */
export interface S3Keys {
  readonly keyId: string;
  readonly secretKey: string;
  readonly sessionToken?: string;
}

const EMPTY_HASH = createHash('sha256').update('').digest('hex');

/** RFC 3986: every byte but the unreserved characters as `%XX`, as SigV4 wants it for query names and values. */
export function encodeRfc3986(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The query string in the canonical order of SigV4; the same text is sent, so nothing is encoded twice. */
export function canonicalQuery(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .toSorted()
    .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(params[name] ?? '')}`)
    .join('&');
}

const hmac = (key: string | Buffer, text: string): Buffer => createHmac('sha256', key).update(text).digest();

/**
 * The headers that sign a GET of `url` (its path and query already encoded the canonical way) for the S3 service in
 * `region` at `now`. `host` is the host and port of the URL, as the HTTP client sends it.
 */
export function signedHeaders(url: URL, region: string, keys: S3Keys, now: Date): Record<string, string> {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': EMPTY_HASH,
    'x-amz-date': amzDate,
    ...(keys.sessionToken ? { 'x-amz-security-token': keys.sessionToken } : {}),
  };
  const names = Object.keys(headers).toSorted();
  const canonical = [
    'GET',
    url.pathname,
    url.search.replace(/^\?/, ''),
    ...names.map((name) => `${name}:${headers[name]?.trim() ?? ''}`),
    '',
    names.join(';'),
    EMPTY_HASH,
  ].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${keys.secretKey}`, day), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${keys.keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}
