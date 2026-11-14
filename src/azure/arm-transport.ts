import { AantjeError } from '../errors';
import { isObject } from '../guards';
import { armErrorOf, armFailure } from './arm-errors';
import { isArmUrl } from './operations';

const ARM_URL = 'https://management.azure.com';

/** The API version of each kind of request. */
export const API = {
  tenants: '2022-12-01',
  subscriptions: '2022-12-01',
  locations: '2022-12-01',
  resources: '2021-04-01',
  deployments: '2024-03-01',
  storage: '2023-05-01',
  postgres: '2024-08-01',
} as const;

export interface ArmOptions {
  readonly fetch?: typeof fetch;
  /** A token for the ARM scope; called for every request, the sign-in caches it. */
  readonly token: () => Promise<string>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly baseUrl?: string;
  /** One line per request: method, path, status, duration and correlation id; never the token or a body. */
  readonly debug?: (message: string) => void;
}

interface ArmResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

/**
 * The requests to Azure Resource Manager: the token on every request, the mapping of a failed answer to an error, and
 * list responses followed page by page, but never to a host other than Resource Manager.
 */
export class ArmTransport {
  readonly sleep: (ms: number) => Promise<void>;
  readonly base: string;
  private readonly http: typeof fetch;

  constructor(private readonly options: ArmOptions) {
    this.http = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.base = options.baseUrl ?? ARM_URL;
  }

  /** All items of a list response, following `nextLink`. */
  async list(pathAndQuery: string): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let url: string | undefined = pathAndQuery.startsWith('http')
      ? pathAndQuery
      : `${this.base}${pathAndQuery}`;
    while (url !== undefined) {
      const page = await this.send('GET', url);
      if (isObject(page)) {
        items.push(...arrayOf(page.value));
        // A link that leaves Azure Resource Manager would carry the token to another host.
        url =
          typeof page.nextLink === 'string' && isArmUrl(page.nextLink, this.base) ? page.nextLink : undefined;
      } else {
        url = undefined;
      }
    }
    return items;
  }

  /** A request to a path below the base, with its API version. */
  request(
    method: string,
    path: string,
    { version, body }: { version: string; body?: object },
  ): Promise<unknown> {
    return this.send(method, `${this.base}${path}?api-version=${version}`, body);
  }

  async send(method: string, url: string, body?: object): Promise<unknown> {
    return (await this.exchange(method, url, body)).body;
  }

  /** One request with the whole answer; a failed one throws `ArmRequestError`, no answer `ArmUnreachableError`. */
  async exchange(method: string, url: string, body?: object): Promise<ArmResponse> {
    const started = Date.now();
    const target = `${method} ${url.startsWith(this.base) ? url.slice(this.base.length) : url}`;
    const unreachable = (cause: unknown): never => {
      this.options.debug?.(`${target}: no answer after ${Date.now() - started} ms`);
      throw new ArmUnreachableError(cause);
    };
    const response = await this.http(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.options.token()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch(unreachable);
    const text = await response.text().catch(unreachable);
    const correlation = response.headers.get('x-ms-correlation-request-id');
    this.options.debug?.(
      `${target}: ${response.status} after ${Date.now() - started} ms${correlation ? ` (correlation id ${correlation})` : ''}`,
    );
    const parsed = parseJson(text);
    if (response.ok) {
      return { status: response.status, headers: response.headers, body: parsed };
    }
    const failure = armFailure(
      armErrorOf(parsed) ?? { code: `HTTP ${response.status}`, message: text.slice(0, 200) },
      response.status,
    );
    throw new ArmRequestError(failure, response.status, isObject(parsed) ? parsed.error : undefined);
  }
}

/** A failed request with its HTTP status; the poll of a deployment tolerates a few 5xx. */
export class ArmRequestError extends AantjeError {
  constructor(
    failure: AantjeError,
    readonly status: number,
    /** The `error` of the answer as Azure sent it, with its details; undefined when the answer had none. */
    readonly armError?: unknown,
  ) {
    super(failure.code, failure.userMessage);
  }
}

/** A request that got no answer (no network, a dropped connection); Azure may still have carried it out. */
export class ArmUnreachableError extends AantjeError {
  constructor(cause: unknown) {
    super('CONNECTION_FAILED', 'Azure Resource Manager could not be reached.', { cause });
  }
}

/** The objects of an array in a response; anything else counts as empty. */
export function arrayOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function parseJson(text: string): unknown {
  try {
    return text === '' ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}
