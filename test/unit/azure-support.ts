import { PendingLakes } from '../../src/azure/pending';
import type { ConnectionProfile } from '../../src/connections/profile';
import { ConnectionStore } from '../../src/connections/store';
import type { Logger } from '../../src/log';

export const OID = '11111111-2222-3333-4444-555555555555';
export const TID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

export function jwt(claims: Record<string, unknown>): string {
  const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.signature`;
}

export class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Record<string, string> = {},
  ) {}
}

/** A logger that keeps each line as `level message`: what the output channel would show. */
export function memoryLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const keep = (level: string) => (message: string) => void lines.push(`${level} ${message}`);
  return {
    log: { debug: keep('debug'), info: keep('info'), warn: keep('warn'), error: keep('error') },
    lines,
  };
}

/** Pending lakes in memory: the global state and the secret storage are two maps the test can look into. */
export function memoryPending(): {
  pending: PendingLakes;
  state: Map<string, unknown>;
  secrets: Map<string, string>;
} {
  const state = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const pending = new PendingLakes(
    { get: (key) => state.get(key), update: (key, value) => Promise.resolve(void state.set(key, value)) },
    {
      get: (key) => Promise.resolve(secrets.get(key)),
      set: (key, value) => Promise.resolve(void secrets.set(key, value)),
      delete: (key) => Promise.resolve(void secrets.delete(key)),
    },
  );
  return { pending, state, secrets };
}

/** The real connection store over memory, so a method handed on without its object fails here as in the extension. */
export class MemoryStore extends ConnectionStore {
  readonly added: { profile: ConnectionProfile; password?: string }[] = [];

  constructor() {
    let setting: unknown;
    const secrets = new Map<string, string>();
    super(
      { read: () => setting, write: (value) => Promise.resolve(void (setting = value)) },
      {
        get: (key) => Promise.resolve(secrets.get(key)),
        set: (key, value) => Promise.resolve(void secrets.set(key, value)),
        delete: (key) => Promise.resolve(void secrets.delete(key)),
      },
    );
  }

  override async add(profile: ConnectionProfile, password?: string): Promise<void> {
    await super.add(profile, password);
    this.added.push({ profile, password });
  }
}

/** A fetch that answers from a table of `METHOD path-fragment` to a body or a status and body; unknown requests fail the test. */
export function fakeAzure(
  routes: Record<string, unknown>,
  calls: { method: string; url: string; body?: unknown }[] = [],
): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const key = Object.keys(routes).find((route) => {
      const [m, fragment] = route.split(' ');
      return m === method && url.includes(fragment ?? '');
    });
    if (key === undefined) {
      return Promise.reject(new Error(`unexpected request: ${method} ${url}`));
    }
    const route = routes[key];
    const answer = typeof route === 'function' ? (route as () => unknown)() : route;
    const reply = answer instanceof Reply ? answer : new Reply(200, answer);
    const body = reply.status === 204 ? null : JSON.stringify(reply.body);
    return Promise.resolve(new Response(body, { status: reply.status, headers: reply.headers }));
  }) as typeof fetch;
}
