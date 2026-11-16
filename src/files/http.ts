import { AantjeError } from '../errors';
import { visibleLine } from '../markdown';

// The plain HTTPS requests of the Files folder: one request with a time limit, no redirect followed (a redirect would carry
// the signature or the token to another place), and the error text of the storage turned into one safe line.

export type Http = typeof fetch;

/** Raw entries as a storage lists them, before they become paths of a root. */
export interface RawEntry {
  /** The key or path below the bucket or container, without the trailing `/` of a folder. */
  readonly key: string;
  readonly folder: boolean;
  readonly size?: number;
  /** Milliseconds since 1970. */
  readonly modified?: number;
}

/** The entries of one level, and whether the listing stopped at its ceiling. */
export interface RawLevel {
  readonly entries: RawEntry[];
  readonly cut: boolean;
}

/** How long one request may take when the caller gives no limit. */
const REQUEST_TIMEOUT_MS = 30_000;

// The storage's own words are shown in the tree: one line, nothing invisible, not too long.
const MAX_TEXT = 300;

/** The storage's error text as one short line. */
export function shownText(text: string): string {
  const line = visibleLine(text).trim();
  return line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT)}…` : line;
}

/** The limits of a request, and who answers it for its error texts ("The storage", "Microsoft Entra ID"). */
export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly service?: string;
}

/**
 * A request that ends after `timeoutMs` or when `signal` aborts and follows no redirect; a network failure becomes an
 * `AantjeError` that names the `service`.
 */
export async function request(
  http: Http,
  url: string,
  init: { readonly method: 'GET' | 'POST'; readonly headers: Record<string, string>; readonly body?: string },
  { signal, timeoutMs = REQUEST_TIMEOUT_MS, service = 'The storage' }: RequestOptions,
): Promise<Response> {
  const limit = AbortSignal.timeout(timeoutMs);
  try {
    return await http(url, {
      ...init,
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new AantjeError('ABORTED', 'The listing was cancelled.', { cause: error });
    }
    if (limit.aborted) {
      throw new AantjeError('TIMEOUT', `${service} did not answer within ${timeoutMs / 1000} s.`, {
        cause: error,
      });
    }
    const reason = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
    throw new AantjeError(
      'CONNECTION_FAILED',
      `${service} cannot be reached${reason === '' ? '.' : `: ${shownText(reason)}`}`,
      { cause: error },
    );
  }
}

/** A GET of a storage that ends after `timeoutMs` or when `signal` aborts (`request`). */
export function get(
  http: Http,
  url: string,
  headers: Record<string, string>,
  options: RequestOptions,
): Promise<Response> {
  return request(http, url, { method: 'GET', headers }, options);
}

/** The refusal of a storage as an error: the HTTP status, the code and the message of its answer. */
export function refusal(status: number, code: string | undefined, message: string | undefined): AantjeError {
  const what = [code, message].filter((part) => part !== undefined && part.trim() !== '').join(': ');
  return new AantjeError(
    status === 401 || status === 403 ? 'AUTH_FAILED' : 'CONNECTION_FAILED',
    shownText(`The storage refused the listing (HTTP ${status}${what === '' ? ')' : `): ${what}`}`),
  );
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML text with its entities replaced. */
export function xmlText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** The inner texts of every `<tag>` element (not nested in another of the same tag), raw. */
export function elements(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map(
    (match) => match[1] ?? '',
  );
}

/** The decoded text of the first `<tag>` element; undefined without one. */
export function element(xml: string, tag: string): string | undefined {
  const found = elements(xml, tag)[0];
  return found === undefined ? undefined : xmlText(found);
}

/** A date of a listing (ISO or RFC 1123) in milliseconds; undefined when it cannot be read. */
export function dateOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const time = Date.parse(text);
  return Number.isNaN(time) ? undefined : time;
}

/** A size of a listing; undefined when it is no whole number. */
export function sizeOf(text: string | undefined): number | undefined {
  if (text === undefined || !/^\d+$/.test(text.trim())) return undefined;
  return Number(text.trim());
}
