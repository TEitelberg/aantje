// After a sync to a Fabric lakehouse: Fabric turns each Iceberg table into a Delta table of its own (5 s to 2 minutes
// after the commit) and writes how that went to `_delta_log/latest_conversion_log.txt`. Until then the SQL analytics
// endpoint reports the table as `DeltaTableNotFound`. This waits for the conversion of the tables a sync wrote.
import type { IcebergName } from '../iceberg/copy';
import type { IcebergTarget } from '../iceberg/target';
import { ONELAKE_HOST } from '../storage/config';

const DFS_VERSION = '2021-06-08';
const REQUEST_TIMEOUT_MS = 15_000;
const POLL_MS = 10_000;
/** Fabric names 2 minutes as the longest conversion; a little more before aantje stops waiting. */
export const CONVERSION_WAIT_MS = 3 * 60_000;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** What became of the conversion of one table. */
export interface Conversion {
  readonly table: IcebergName;
  /** `pending`: Fabric had not converted the version that the sync wrote when aantje stopped waiting. */
  readonly state: 'converted' | 'failed' | 'pending';
  /** The `Error Details` of the log of a failed conversion. */
  readonly detail?: string;
}

export interface ConversionOptions {
  readonly fetch?: Fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  /** Told while waiting: how many tables are converted. */
  readonly report?: (text: string) => void;
  readonly waitMs?: number;
}

/** The lines of a conversion log that matter: its status, the metadata file it converted, and the error details. */
export function readConversionLog(text: string): {
  readonly status?: string;
  readonly metadata?: string;
  readonly detail?: string;
} {
  const field = (name: string): string | undefined =>
    new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, 'im').exec(text)?.[1];
  const status = field('Status');
  const metadata = field('Latest Metadata');
  const detail = field('Error Details');
  return {
    ...(status === undefined ? {} : { status }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * Waits until Fabric has converted the version of each table that the sync wrote: the newest metadata file of the table
 * (from the Iceberg catalog of OneLake) is the one its conversion log names. Reads only from the fixed hosts of OneLake,
 * with the token of the sync. Tables that are not converted when the time is up stay `pending`.
 */
export async function waitForConversion(
  target: IcebergTarget,
  token: string,
  tables: readonly IcebergName[],
  options: ConversionOptions = {},
): Promise<Conversion[]> {
  const fabric = target.fabric;
  if (!fabric || tables.length === 0) return [];
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  const get = reader(options.fetch ?? fetch, token);
  const segment = encodeURIComponent;
  const expected = new Map<IcebergName, string | undefined>();
  for (const table of tables) {
    const text = await get(
      `${target.endpoint}/v1/${fabric.workspace}/${fabric.lakehouse}/namespaces/${segment(table.namespace)}/tables/${segment(table.name)}`,
    );
    expected.set(table, text === undefined ? undefined : metadataFile(text));
  }
  const logOf = (table: IcebergName): string =>
    `https://${ONELAKE_HOST}/${fabric.workspace}/${fabric.lakehouse}/Tables/${
      fabric.schemas ? `${segment(table.namespace)}/${segment(table.name)}` : segment(table.name)
    }/_delta_log/latest_conversion_log.txt`;

  const done = new Map<IcebergName, Conversion>();
  for (;;) {
    for (const table of tables.filter((candidate) => !done.has(candidate))) {
      const text = await get(logOf(table), { 'x-ms-version': DFS_VERSION });
      const conversion = text === undefined ? undefined : conversionOf(table, text, expected.get(table));
      if (conversion) done.set(table, conversion);
    }
    options.report?.(`${done.size} of ${tables.length} tables converted`);
    if (done.size === tables.length || options.signal?.aborted) break;
    if (now() - started >= (options.waitMs ?? CONVERSION_WAIT_MS)) break;
    await sleep(POLL_MS);
  }
  return tables.map((table) => done.get(table) ?? { table, state: 'pending' });
}

/** A GET with the token that returns the text of an answer of 2xx, else undefined (also when there is no answer). */
function reader(
  http: Fetch,
  token: string,
): (url: string, headers?: Record<string, string>) => Promise<string | undefined> {
  return async (url, headers = {}) => {
    try {
      const response = await http(url, {
        headers: { authorization: `Bearer ${token}`, ...headers },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return response.ok ? await response.text() : undefined;
    } catch {
      return undefined;
    }
  };
}

/** The conversion that the log tells, once it is about the metadata file the sync wrote (or any, when unknown). */
function conversionOf(table: IcebergName, text: string, wanted: string | undefined): Conversion | undefined {
  const log = readConversionLog(text);
  if (log.status === undefined || (wanted !== undefined && log.metadata !== wanted)) return undefined;
  if (/^succeeded$/i.test(log.status)) return { table, state: 'converted' };
  return { table, state: 'failed', ...(log.detail === undefined ? {} : { detail: log.detail }) };
}

/** The file name of the newest metadata of a table, from the answer of the catalog. */
function metadataFile(text: string): string | undefined {
  const location = metadataLocation(text);
  return location?.slice(location.lastIndexOf('/') + 1);
}

function metadataLocation(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as { 'metadata-location'?: unknown };
    return typeof body['metadata-location'] === 'string' ? body['metadata-location'] : undefined;
  } catch {
    return undefined;
  }
}
