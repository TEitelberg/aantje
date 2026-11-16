import { AantjeError } from '../errors';
import { isObject } from '../guards';
import { azureHeaders } from './azure-auth';
import type { AzureAccess } from './azure-auth';
import { dateOf, element, elements, get, refusal, sizeOf, xmlText } from './http';
import type { Http, RawEntry, RawLevel } from './http';
import { encodeRfc3986 } from './sigv4';

// One level of an Azure container or OneLake workspace. ADLS Gen2 (`abfss://`) and OneLake are listed through the DFS
// API ("List Paths" without recursion); a Blob path (`az://`) through "List Blobs" with the delimiter `/`. Either answers
// with the entries of the level only.

const PAGE = 5000;

export interface AzureListOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

function query(params: Readonly<Record<string, string | undefined>>, sas: string | undefined): string {
  const pairs = Object.entries(params).flatMap(([name, value]) =>
    value === undefined ? [] : [`${name}=${encodeRfc3986(value)}`],
  );
  return [...pairs, ...(sas ? [sas] : [])].join('&');
}

async function send(
  http: Http,
  access: AzureAccess,
  url: URL,
  options: AzureListOptions,
): Promise<{ response: Response; body: string }> {
  const headers = azureHeaders(url, access.auth, options.now?.() ?? new Date());
  const response = await get(http, url.toString(), headers, options);
  return { response, body: await response.text() };
}

// An Azure error: the code in a header (and in the body), the message in JSON (DFS) or XML (Blob), its first line
// only (the rest names the request id and time).
function azureRefusal(response: Response, body: string): Error {
  let code = response.headers.get('x-ms-error-code') ?? undefined;
  let message: string | undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : undefined;
    code ??= typeof error?.code === 'string' ? error.code : undefined;
    message = typeof error?.message === 'string' ? error.message : undefined;
  } catch {
    code ??= element(body, 'Code');
    message = element(body, 'Message');
  }
  return refusal(response.status, code, message?.split(/\r?\n/)[0]);
}

const flag = (value: unknown): boolean => value === true || value === 'true';

// An answer of 200 that is no JSON did not come from the DFS API (a proxy, a captive portal).
function jsonOf(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new AantjeError('CONNECTION_FAILED', 'The storage answered with something that is no listing.', {
      cause,
    });
  }
}

const nonEmpty = (text: string | null | undefined): string | undefined =>
  text === null || text === undefined || text === '' ? undefined : text;

/** The entries of one level of `filesystem` below `directory` (a path without a trailing `/`, `''` for the root). */
export async function listDfsLevel(
  http: Http,
  access: AzureAccess,
  filesystem: string,
  directory: string,
  ceiling: number,
  options: AzureListOptions = {},
): Promise<RawLevel> {
  const entries: RawEntry[] = [];
  let continuation: string | undefined;
  do {
    const search = query(
      {
        resource: 'filesystem',
        recursive: 'false',
        maxResults: String(PAGE),
        directory: directory === '' ? undefined : directory,
        continuation,
      },
      access.auth.kind === 'sas' ? access.auth.query : undefined,
    );
    const url = new URL(`${access.protocol}://${access.dfsHost}/${encodeURIComponent(filesystem)}?${search}`);
    const { response, body } = await send(http, access, url, options);
    if (response.status !== 200) throw azureRefusal(response, body);
    const parsed = jsonOf(body);
    const paths = isObject(parsed) && Array.isArray(parsed.paths) ? parsed.paths : [];
    for (const path of paths) {
      if (!isObject(path) || typeof path.name !== 'string') continue;
      const folder = flag(path.isDirectory);
      const length = path.contentLength;
      const size =
        folder || (typeof length !== 'string' && typeof length !== 'number')
          ? undefined
          : sizeOf(String(length));
      const modified = dateOf(typeof path.lastModified === 'string' ? path.lastModified : undefined);
      entries.push({
        key: path.name,
        folder,
        ...(size === undefined ? {} : { size }),
        ...(modified === undefined ? {} : { modified }),
      });
    }
    continuation = nonEmpty(response.headers.get('x-ms-continuation'));
  } while (continuation !== undefined && entries.length < ceiling);
  return { entries: entries.slice(0, ceiling), cut: continuation !== undefined || entries.length > ceiling };
}

// A name the service could not write as XML comes percent-encoded with `Encoded="true"`.
function blobName(xml: string): string {
  const match = /<Name(\s+Encoded="true")?\s*>([\s\S]*?)<\/Name>/.exec(xml);
  const text = xmlText(match?.[2] ?? '');
  if (match?.[1] === undefined) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The entries of one level of `container` below `prefix` (`''` or ending in `/`). */
export async function listBlobLevel(
  http: Http,
  access: AzureAccess & { readonly blobHost: string },
  container: string,
  prefix: string,
  ceiling: number,
  options: AzureListOptions = {},
): Promise<RawLevel> {
  const entries: RawEntry[] = [];
  const folders = new Set<string>();
  let marker: string | undefined;
  do {
    const search = query(
      {
        restype: 'container',
        comp: 'list',
        delimiter: '/',
        include: 'metadata',
        maxresults: String(PAGE),
        prefix: prefix === '' ? undefined : prefix,
        marker,
      },
      access.auth.kind === 'sas' ? access.auth.query : undefined,
    );
    const url = new URL(`${access.protocol}://${access.blobHost}/${encodeURIComponent(container)}?${search}`);
    const { response, body } = await send(http, access, url, options);
    if (response.status !== 200) throw azureRefusal(response, body);
    for (const block of elements(body, 'BlobPrefix')) {
      const key = blobName(block).replace(/\/$/, '');
      if (key.length > prefix.length && !folders.has(key)) {
        folders.add(key);
        entries.push({ key, folder: true });
      }
    }
    for (const block of elements(body, 'Blob')) {
      const key = blobName(block);
      // With a hierarchical namespace a folder is also a blob, marked in its metadata.
      const directory = /<hdi_isfolder>\s*true\s*<\/hdi_isfolder>/i.test(block);
      if (key === prefix || key.endsWith('/') || (directory && folders.has(key))) continue;
      if (directory) {
        folders.add(key);
        entries.push({ key, folder: true });
        continue;
      }
      const size = sizeOf(element(block, 'Content-Length'));
      const modified = dateOf(element(block, 'Last-Modified'));
      entries.push({
        key,
        folder: false,
        ...(size === undefined ? {} : { size }),
        ...(modified === undefined ? {} : { modified }),
      });
    }
    marker = nonEmpty(element(body, 'NextMarker'));
  } while (marker !== undefined && entries.length < ceiling);
  return { entries: entries.slice(0, ceiling), cut: marker !== undefined || entries.length > ceiling };
}
