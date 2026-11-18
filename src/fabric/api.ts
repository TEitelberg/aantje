// The Fabric REST API, as far as a Sync to Iceberg into a lakehouse needs it: find a workspace, list its lakehouses and
// create one with schemas. Signs in with the Microsoft account of VS Code; every step goes to the aantje output.
import { AantjeError } from '../errors';
import { isObject } from '../guards';
import type { Logger } from '../log';
import { isGuid } from '../storage/config';

export const FABRIC_API = 'https://api.fabric.microsoft.com/v1';
const FABRIC_HOST = 'api.fabric.microsoft.com';
const REQUEST_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 5 * 60_000;
const TOLERATED_POLL_FAILURES = 3;
/** The most tables one `refreshMetadata` takes. */
const REFRESH_BATCH = 25;

export interface FabricWorkspace {
  readonly id: string;
  readonly name: string;
  /** Undefined when the workspace has no Fabric capacity: then it can hold no lakehouse. */
  readonly capacityId?: string;
}

export interface FabricLakehouseItem {
  readonly id: string;
  readonly name: string;
  /** Whether the lakehouse has schemas (`defaultSchema` is set); one without has only `dbo`. */
  readonly schemas: boolean;
}

/** What the SQL analytics endpoint made of one table when it read it again. */
export interface SqlTableSync {
  /** `schema.table` in a lakehouse with schemas, else the table name. */
  readonly name: string;
  /** `Success`, `Failure` or `NotRun`. */
  readonly status: string;
  readonly error?: string;
}

/** The part of `fetch` the client uses; a test passes its own. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface FabricApiOptions {
  /** A token for the Fabric API (scope `https://api.fabric.microsoft.com/.default`). */
  readonly token: () => Promise<string>;
  readonly log: Logger;
  readonly fetch?: Fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** The letters, digits and underscores that Fabric allows in the name of a lakehouse, starting with a letter. */
export function validateLakehouseName(value: string): string | undefined {
  return /^[A-Za-z][A-Za-z0-9_]{0,255}$/.test(value.trim())
    ? undefined
    : 'A lakehouse name has letters, digits and _ and starts with a letter.';
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

export class FabricApi {
  private readonly http: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: FabricApiOptions) {
    this.http = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  /** The workspace by its id or its name (a name ignores case); an error when this account sees none of that name. */
  async workspace(text: string): Promise<FabricWorkspace> {
    const wanted = text.trim();
    this.options.log.info(`Fabric: looking up the workspace "${wanted}".`);
    if (isGuid(wanted)) {
      return workspaceOf(
        (await this.request('GET', `${FABRIC_API}/workspaces/${wanted.toLowerCase()}`)).body,
      );
    }
    const all = (await this.list(`${FABRIC_API}/workspaces`)).map(workspaceOf);
    const found = all.filter((workspace) => workspace.name.toLowerCase() === wanted.toLowerCase());
    if (found.length === 1 && found[0]) return found[0];
    throw new AantjeError(
      'QUERY_FAILED',
      found.length === 0
        ? `Your Microsoft account sees no Fabric workspace named "${wanted}" (${all.length} workspaces). Check the name or enter the workspace ID.`
        : `${found.length} Fabric workspaces are named "${wanted}". Enter the workspace ID instead.`,
    );
  }

  /** The lakehouses of the workspace, by name. */
  async lakehouses(workspaceId: string): Promise<FabricLakehouseItem[]> {
    const items = (await this.list(`${FABRIC_API}/workspaces/${workspaceId}/lakehouses`)).map(lakehouseOf);
    this.options.log.info(`Fabric: the workspace ${workspaceId} has ${items.length} lakehouses.`);
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Creates a lakehouse with schemas and waits until Fabric has made it: Fabric answers at once (201) or with an
   * operation to follow (202). `report` gets the state of the operation.
   */
  async createLakehouse(
    workspaceId: string,
    name: string,
    report: (text: string) => void = () => undefined,
  ): Promise<FabricLakehouseItem> {
    const started = this.now();
    this.options.log.info(
      `Fabric: creating the lakehouse "${name}" with schemas in the workspace ${workspaceId}.`,
    );
    const created = await this.request('POST', `${FABRIC_API}/workspaces/${workspaceId}/lakehouses`, {
      displayName: name,
      description: 'Created by aantje for Sync to Iceberg.',
      creationPayload: { enableSchemas: true },
    });
    const item = await this.finished(created, started, report, 'create the lakehouse');
    // The answer of a finished operation may lack the properties: the lakehouse itself has them.
    const id = isObject(item) && typeof item.id === 'string' ? item.id : undefined;
    const lakehouse = id
      ? lakehouseOf(
          (await this.request('GET', `${FABRIC_API}/workspaces/${workspaceId}/lakehouses/${id}`)).body,
        )
      : (await this.lakehouses(workspaceId)).find((candidate) => candidate.name === name);
    if (!lakehouse)
      throw new AantjeError('QUERY_FAILED', `Fabric made the lakehouse "${name}" but does not list it.`);
    this.options.log.info(
      `Fabric: created the lakehouse "${lakehouse.name}" (${lakehouse.id}) after ${Math.round((this.now() - started) / 1000)} s.`,
    );
    return lakehouse;
  }

  /** The id of the SQL analytics endpoint of the lakehouse; undefined while Fabric has not made it yet. */
  async sqlEndpointOf(workspaceId: string, lakehouseId: string): Promise<string | undefined> {
    const body = (
      await this.request('GET', `${FABRIC_API}/workspaces/${workspaceId}/lakehouses/${lakehouseId}`)
    ).body;
    const properties = isObject(body) && isObject(body.properties) ? body.properties : {};
    const endpoint = isObject(properties.sqlEndpointProperties) ? properties.sqlEndpointProperties : {};
    return typeof endpoint.id === 'string' ? endpoint.id : undefined;
  }

  /**
   * Asks the SQL analytics endpoint to read the tables again (`refreshMetadata`), 25 at a time as Fabric allows, and
   * returns what came of each table: its name (`schema.table` in a lakehouse with schemas), `Success`, `Failure` or
   * `NotRun`, and the reason of a failure.
   */
  async refreshSqlEndpoint(
    workspaceId: string,
    sqlEndpointId: string,
    tables: readonly { readonly schema: string; readonly name: string }[],
    report: (text: string) => void = () => undefined,
  ): Promise<SqlTableSync[]> {
    const results: SqlTableSync[] = [];
    for (let start = 0; start < tables.length; start += REFRESH_BATCH) {
      const batch = tables.slice(start, start + REFRESH_BATCH);
      const schemas = [...new Set(batch.map((table) => table.schema))];
      this.options.log.info(
        `Fabric: the SQL analytics endpoint reads ${batch.length} tables again (${start + batch.length} of ${tables.length}).`,
      );
      const answer = await this.request(
        'POST',
        `${FABRIC_API}/workspaces/${workspaceId}/sqlEndpoints/${sqlEndpointId}/refreshMetadata`,
        {
          tables: schemas.map((schema) => ({
            schema,
            tableNames: batch.filter((table) => table.schema === schema).map((table) => table.name),
          })),
        },
      );
      const body = await this.finished(answer, this.now(), report, 'refresh the SQL analytics endpoint');
      const values = isObject(body) && Array.isArray(body.value) ? (body.value as unknown[]) : [];
      results.push(...values.map(sqlTableSyncOf));
    }
    return results;
  }

  /** The body of a finished request: at once (200, 201) or after its long-running operation (202). */
  private async finished(
    answer: Answer,
    started: number,
    report: (text: string) => void,
    what: string,
  ): Promise<unknown> {
    if (answer.status !== 202) return answer.body;
    const operation = fabricUrl(answer.headers.get('location'));
    if (!operation) {
      throw new AantjeError(
        'QUERY_FAILED',
        `Fabric accepted the request to ${what} but named no operation to follow.`,
      );
    }
    return this.follow(operation, retryAfter(answer.headers), started, report, what);
  }

  /** Follows a long-running operation of Fabric to its result. */
  private async follow(
    operation: string,
    firstPause: number,
    started: number,
    report: (text: string) => void,
    what: string,
  ): Promise<unknown> {
    let pause = firstPause;
    let failures = 0;
    for (;;) {
      if (this.now() - started > CREATE_TIMEOUT_MS) {
        throw new AantjeError(
          'TIMEOUT',
          `Fabric did not ${what} within ${CREATE_TIMEOUT_MS / 60_000} minutes; look in the workspace what became of it.`,
        );
      }
      await this.sleep(pause);
      // A dropped answer or a server error is asked again a few times; the operation goes on in Fabric.
      const answer = await this.request('GET', operation).catch((error: unknown) => {
        failures += 1;
        if (failures > TOLERATED_POLL_FAILURES || !isPassing(error)) throw error;
        return undefined;
      });
      if (answer === undefined) continue;
      failures = 0;
      const status =
        isObject(answer.body) && typeof answer.body.status === 'string' ? answer.body.status : 'Unknown';
      report(`Fabric: ${status}`);
      this.options.log.info(
        `Fabric: the operation is ${status} after ${Math.round((this.now() - started) / 1000)} s.`,
      );
      if (status === 'Succeeded')
        return (await this.request('GET', `${operation.replace(/\/+$/, '')}/result`)).body;
      if (status === 'Failed' || status === 'Cancelled') {
        const error = isObject(answer.body) && isObject(answer.body.error) ? answer.body.error : {};
        throw new AantjeError(
          'QUERY_FAILED',
          `Fabric could not ${what}: ${typeof error.message === 'string' ? error.message : status}`,
        );
      }
      pause = retryAfter(answer.headers);
    }
  }

  /** The `value` of every page, following `continuationUri` while it stays on the Fabric API. */
  private async list(first: string): Promise<unknown[]> {
    const values: unknown[] = [];
    for (let url: string | undefined = first; url !== undefined;) {
      const page: Answer = await this.request('GET', url);
      const body = isObject(page.body) ? page.body : {};
      if (Array.isArray(body.value)) values.push(...(body.value as unknown[]));
      url = fabricUrl(typeof body.continuationUri === 'string' ? body.continuationUri : null);
    }
    return values;
  }

  private async request(method: string, url: string, body?: object): Promise<Answer> {
    const started = this.now();
    const shown = `${method} ${url.replace(FABRIC_API, '')}`;
    let response: Response;
    try {
      response = await this.http(url, {
        method,
        headers: {
          authorization: `Bearer ${await this.options.token()}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      if (cause instanceof AantjeError) throw cause;
      this.options.log.debug(`Fabric: ${shown}: no answer after ${this.now() - started} ms`);
      throw new FabricUnreachableError(cause);
    }
    const text = await response.text().catch(() => '');
    const request = response.headers.get('requestid') ?? response.headers.get('x-ms-request-id');
    this.options.log.debug(
      `Fabric: ${shown}: ${response.status} after ${this.now() - started} ms${request ? ` (request id ${request})` : ''}`,
    );
    const parsed = parse(text);
    if (response.ok) return { status: response.status, body: parsed, headers: response.headers };
    throw new FabricRequestError(response.status, failureText(response.status, parsed, text));
  }
}

/** A failed request with its HTTP status. */
export class FabricRequestError extends AantjeError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(status === 401 || status === 403 ? 'AUTH_FAILED' : 'QUERY_FAILED', message);
  }
}

/** A request that got no answer. */
export class FabricUnreachableError extends AantjeError {
  constructor(cause: unknown) {
    super('CONNECTION_FAILED', 'The Fabric API could not be reached.', { cause });
  }
}

const isPassing = (error: unknown): boolean =>
  error instanceof FabricUnreachableError || (error instanceof FabricRequestError && error.status >= 500);

function failureText(status: number, body: unknown, text: string): string {
  const message =
    isObject(body) && typeof body.message === 'string'
      ? `${typeof body.errorCode === 'string' ? `${body.errorCode}: ` : ''}${body.message}`
      : text.slice(0, 200) || `HTTP ${status}`;
  if (status === 401) return `Fabric refused the sign-in (${message}).`;
  if (status === 403) {
    return `Fabric refused the request: your account needs the role Contributor or higher in the workspace (${message}).`;
  }
  if (status === 404)
    return `Fabric does not know this workspace or lakehouse, or your account cannot see it (${message}).`;
  return `The Fabric API answered ${status}: ${message}`;
}

function parse(text: string): unknown {
  try {
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/** The URL when it is an https address of the Fabric API; anything else is not followed. */
function fabricUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === FABRIC_HOST ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The pause Fabric asks for, 1 to 10 s. */
function retryAfter(headers: Headers): number {
  const seconds = Number(headers.get('retry-after') ?? '3');
  return Math.min(Math.max(Number.isFinite(seconds) ? seconds : 3, 1), 10) * 1000;
}

function workspaceOf(value: unknown): FabricWorkspace {
  const item = isObject(value) ? value : {};
  const id = typeof item.id === 'string' ? item.id : '';
  return {
    id,
    name: typeof item.displayName === 'string' ? item.displayName : id,
    ...(typeof item.capacityId === 'string' ? { capacityId: item.capacityId } : {}),
  };
}

function sqlTableSyncOf(value: unknown): SqlTableSync {
  const item = isObject(value) ? value : {};
  const error = isObject(item.error) ? item.error : {};
  const reason = [error.errorCode, error.message].filter((part) => typeof part === 'string').join(': ');
  return {
    name: typeof item.tableName === 'string' ? item.tableName : '?',
    status: typeof item.status === 'string' ? item.status : 'Unknown',
    ...(reason === '' ? {} : { error: reason }),
  };
}

function lakehouseOf(value: unknown): FabricLakehouseItem {
  const item = isObject(value) ? value : {};
  const properties = isObject(item.properties) ? item.properties : {};
  const id = typeof item.id === 'string' ? item.id : '';
  return {
    id,
    name: typeof item.displayName === 'string' ? item.displayName : id,
    schemas: typeof properties.defaultSchema === 'string' && properties.defaultSchema !== '',
  };
}
