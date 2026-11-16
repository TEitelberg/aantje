import type { PickItem, WizardUi } from '../connections/ports';
import { validateRequired } from '../connections/profile';
import { AantjeError, isAantjeError, isAborted } from '../errors';
import type { CopyRequest, CopyResult, CopyScope, ExistingTables } from './copy';
import { describeTarget, LAKE_COPY } from './copy';
import type { TablePlan } from './mapping';
import type { IcebergCopies, IcebergCopyRecord } from './records';
import type { IcebergTargetStore } from './store';
import { DEFAULT_REGION, idOf, usesSecret, validateEndpoint } from './target';
import type { IcebergSignIn, IcebergTarget } from './target';

export interface IcebergFlowDeps {
  readonly targets: Pick<IcebergTargetStore, 'list' | 'add' | 'secret' | 'setSecret'>;
  readonly copies: Pick<IcebergCopies, 'replaceAll' | 'replaceSchema' | 'save'>;
  /** The ids of the tables of the lake at a snapshot, by `schema.table`; the records keep them so that a rename is no drop. */
  readonly tableIds?: (snapshot: number) => Promise<ReadonlyMap<string, number>>;
  /**
   * What a copy of the scope does with each table, read from the catalog before anything is written: the columns that
   * Iceberg gets as another type, those it cannot hold, and the `PARTITIONED BY` list of each partitioned table that
   * Iceberg can partition alike (by `schema.table`).
   */
  readonly plan?: (
    scope: CopyScope,
  ) => Promise<{ readonly tables: readonly TablePlan[]; readonly partitions: ReadonlyMap<string, string> }>;
  /** Runs the copy under a notification with Cancel. */
  readonly copy: (request: Omit<CopyRequest, 'access' | 'report'>, title: string) => Promise<CopyResult>;
  /**
   * The sync of what was synced before: when an earlier sync to the target covers the source, it brings those tables
   * up to date (`synced`, or `cancelled`) and the wizard of a first sync does not run; undefined when none covers it.
   */
  readonly syncCovered?: (
    target: IcebergTarget,
    secret: string | undefined,
    source: CopySource,
  ) => Promise<'synced' | 'cancelled' | undefined>;
  readonly now?: () => Date;
}

/** What Sync to Iceberg was started on: the connection, a schema of it, or a table. */
export type CopySource =
  | { readonly kind: 'lake' }
  | { readonly kind: 'schema'; readonly schema: string }
  | { readonly kind: 'table'; readonly schema: string; readonly table: string };

/** What Sync to Iceberg did: the target the user chose, and the result of a first sync (none for a sync of what was synced before). */
export interface IcebergCopied {
  readonly target: IcebergTarget;
  readonly result?: CopyResult;
}

const NEW_TARGET = 'new';

const SIGN_IN_ITEMS: readonly PickItem<IcebergSignIn>[] = [
  {
    label: 'OAuth2 client credentials',
    description: 'A client ID and a client secret (Polaris, Lakekeeper)',
    value: 'oauth2',
  },
  { label: 'Bearer token', description: 'A token that the catalog accepts', value: 'token' },
  { label: 'None', description: 'The catalog needs no sign-in', value: 'none' },
];

const EXISTING_ITEMS: readonly PickItem<ExistingTables>[] = [
  {
    label: 'Stop if a table exists',
    description: 'Write nothing when the catalog has one of the tables already',
    value: 'stop',
  },
  {
    label: 'Replace tables that exist',
    description: 'Drop each existing Iceberg table of the same name and write it new',
    value: 'replace',
  },
];

/**
 * Asks for a new target (name, endpoint, warehouse, sign-in) and saves it. The region and the vended credentials take
 * their defaults, the OAuth2 server its default path below the endpoint; the setting holds them for those who need more.
 */
export async function addIcebergTargetFlow(
  ui: WizardUi,
  deps: Pick<IcebergFlowDeps, 'targets'>,
): Promise<IcebergTarget | undefined> {
  const title = 'Add Iceberg Target';
  const existing = deps.targets.list();
  const name = await ui.input({
    title: `${title} (1/5)`,
    prompt: 'Name of the Iceberg catalog, as shown when you copy a lake',
    validate: (value) =>
      validateRequired('Name')(value) ??
      (existing.some((target) => target.name.toLowerCase() === value.trim().toLowerCase())
        ? 'An Iceberg target with this name already exists.'
        : undefined),
  });
  if (name === undefined) return undefined;
  const endpoint = await ui.input({
    title: `${title} (2/5)`,
    prompt: 'REST endpoint of the catalog, for example http://polaris:8181/api/catalog',
    validate: validateEndpoint,
  });
  if (endpoint === undefined) return undefined;
  const warehouse = await ui.input({
    title: `${title} (3/5)`,
    prompt: 'Warehouse or catalog name (what the REST catalog calls the warehouse)',
    validate: validateRequired('Warehouse'),
  });
  if (warehouse === undefined) return undefined;
  const signIn = await ui.pick(`${title} (4/5): how do you sign in to the catalog?`, SIGN_IN_ITEMS);
  if (signIn === undefined) return undefined;
  let clientId: string | undefined;
  let secret: string | undefined;
  if (signIn === 'oauth2') {
    clientId = await ui.input({
      title: `${title} (5/5)`,
      prompt: 'Client ID',
      validate: validateRequired('Client ID'),
    });
    if (clientId === undefined) return undefined;
  }
  if (signIn !== 'none') {
    secret = await ui.input({
      title: `${title} (5/5)`,
      prompt:
        signIn === 'oauth2'
          ? 'Client secret (kept in the secret storage, not in the settings)'
          : 'Token (kept in the secret storage, not in the settings)',
      password: true,
      validate: validateRequired(signIn === 'oauth2' ? 'Client secret' : 'Token'),
    });
    if (secret === undefined) return undefined;
  }
  const target: IcebergTarget = {
    id: idOf(name, existing),
    name: name.trim(),
    endpoint: endpoint.trim().replace(/\/+$/, ''),
    warehouse: warehouse.trim(),
    signIn,
    ...(clientId === undefined ? {} : { clientId: clientId.trim() }),
    region: DEFAULT_REGION,
    vendedCredentials: true,
  };
  await deps.targets.add(target, secret);
  return target;
}

/** The target to copy to: a saved one, or a new one that is asked for now. */
async function chooseTarget(ui: WizardUi, deps: IcebergFlowDeps): Promise<IcebergTarget | undefined> {
  const targets = deps.targets.list();
  if (targets.length === 0) return addIcebergTargetFlow(ui, deps);
  const items: PickItem<string>[] = [
    ...targets.map((target) => ({
      label: target.name,
      description: `${target.warehouse} at ${target.endpoint}`,
      value: target.id,
    })),
    { label: 'New Iceberg target...', description: 'Another REST catalog', value: NEW_TARGET },
  ];
  const picked = await ui.pick('Sync to Iceberg: which catalog?', items);
  if (picked === undefined) return undefined;
  return picked === NEW_TARGET
    ? addIcebergTargetFlow(ui, deps)
    : targets.find((target) => target.id === picked);
}

/** The scope of a copy: for a schema the namespace, for a table the namespace and the name, asked with defaults. */
async function scopeOf(ui: WizardUi, source: CopySource): Promise<CopyScope | undefined> {
  if (source.kind === 'lake') return LAKE_COPY;
  const namespace = await ui.input({
    title: 'Sync to Iceberg: namespace',
    prompt: 'The Iceberg namespace to write to',
    value: source.schema,
    validate: validateRequired('Namespace'),
  });
  if (namespace === undefined) return undefined;
  if (source.kind === 'schema') return { kind: 'schema', schema: source.schema, namespace: namespace.trim() };
  const name = await ui.input({
    title: 'Sync to Iceberg: table name',
    prompt: 'The name of the Iceberg table',
    value: source.table,
    validate: validateRequired('Table name'),
  });
  if (name === undefined) return undefined;
  return { ...source, namespace: namespace.trim(), name: name.trim() };
}

/** What is copied, in words: `all tables of "lake"`, `the tables of schema "s" of "lake"`, `the table s.t of "lake"`. */
function whatText(scope: CopyScope, lake: string): string {
  if (scope.kind === 'lake') return `all tables of "${lake}"`;
  if (scope.kind === 'schema') return `the tables of the schema "${scope.schema}" of "${lake}"`;
  return `the table ${scope.schema}.${scope.table} of "${lake}"`;
}

const whereText = (scope: CopyScope): string =>
  scope.kind === 'lake'
    ? ''
    : ` as ${scope.kind === 'schema' ? `the namespace "${scope.namespace}"` : `${scope.namespace}.${scope.name}`}`;

/** What the plan says before the copy: the columns written as another type, and the tables that Iceberg cannot hold. */
export function planText(tables: readonly TablePlan[]): string {
  const converted = tables.flatMap((table) =>
    table.converted.map((column) => `${table.schema}.${table.table}.${column}`),
  );
  const failing = tables.filter((table) => table.unwritable.length > 0);
  const listed = (items: readonly string[]): string =>
    `${items.slice(0, 3).join('; ')}${items.length > 3 ? `; and ${items.length - 3} more` : ''}`;
  return [
    ...(converted.length === 0
      ? []
      : [
          `${converted.length} ${converted.length === 1 ? 'column is' : 'columns are'} written as another type (${listed(converted)}).`,
        ]),
    ...(failing.length === 0
      ? []
      : [
          `Iceberg cannot hold ${failing.length === 1 ? 'a column of 1 table' : `columns of ${failing.length} tables`}, which will fail (${listed(failing.map((table) => `${table.schema}.${table.table}: ${table.unwritable.join(', ')}`))}).`,
        ]),
  ].join(' ');
}

/**
 * Sync to Iceberg for a lake, a schema or a table: asks for the target (a saved one or a new one), the namespace and
 * name where the copy goes, what to do with tables that exist and a confirmation that says what does not map one to one;
 * copies the tables at one snapshot and remembers each copy. Returns the target and the result, or undefined when the
 * user cancelled.
 */
export async function copyToIcebergFlow(
  ui: WizardUi,
  deps: IcebergFlowDeps,
  lake: { readonly id: string; readonly name: string },
  snapshot: number | undefined,
  source: CopySource = { kind: 'lake' },
): Promise<IcebergCopied | undefined> {
  const target = await chooseTarget(ui, deps);
  if (!target) return undefined;
  let secret = await deps.targets.secret(target);
  if (usesSecret(target) && secret === undefined) {
    secret = await ui.input({
      title: `Sign in to "${target.name}"`,
      prompt: target.signIn === 'oauth2' ? `Client secret of ${target.clientId}` : 'Token',
      password: true,
      validate: validateRequired(target.signIn === 'oauth2' ? 'Client secret' : 'Token'),
    });
    if (secret === undefined) return undefined;
    await deps.targets.setSecret(target, secret);
  }
  const covered = await deps.syncCovered?.(target, secret, source);
  if (covered === 'synced') return { target };
  if (covered === 'cancelled') return undefined;
  const scope = await scopeOf(ui, source);
  if (!scope) return undefined;
  const existing = await ui.pick('Sync to Iceberg: if the catalog has a table already', EXISTING_ITEMS);
  if (existing === undefined) return undefined;
  const plan = await deps.plan?.(scope).catch(() => undefined);
  const at = snapshot === undefined ? 'the newest snapshot' : `snapshot ${snapshot}`;
  const notes = plan ? planText(plan.tables) : '';
  const confirmed = await ui.confirm(
    `Sync ${whatText(scope, lake.name)} at ${at} to ${describeTarget(target)}${whereText(scope)}? The data is read here and written to the storage of the Iceberg catalog; views and macros are not copied.${notes === '' ? '' : ` ${notes}`}`,
    'Sync',
  );
  if (!confirmed) return undefined;

  const result = await copyAndRecord(ui, deps, lake, target, secret, existing, scope, plan?.partitions);
  return { target, result };
}

/** Runs the copy, remembers every table that was copied and tells what happened. */
async function copyAndRecord(
  ui: WizardUi,
  deps: IcebergFlowDeps,
  lake: { readonly id: string; readonly name: string },
  target: IcebergTarget,
  secret: string | undefined,
  existing: ExistingTables,
  scope: CopyScope = LAKE_COPY,
  partitions?: ReadonlyMap<string, string>,
): Promise<CopyResult> {
  let result: CopyResult;
  try {
    result = await deps.copy(
      { target, secret, existing, scope, ...(partitions === undefined ? {} : { partitions }) },
      `Syncing ${whatText(scope, lake.name)} to ${target.name}...`,
    );
  } catch (error) {
    // The command reports it once: a cancel as a stop, anything else as a failure of the copy.
    if (isAborted(error) || !isAantjeError(error)) throw error;
    throw new AantjeError(error.code, `Sync to Iceberg failed: ${error.userMessage}`, { cause: error });
  }
  const copiedAt = (deps.now?.() ?? new Date()).toISOString();
  const ids = await deps.tableIds?.(result.snapshot).catch(() => undefined);
  const records: IcebergCopyRecord[] = result.tables
    .filter((table) => table.status === 'copied')
    .map((table) => {
      const tableId = ids?.get(`${table.schema}.${table.table}`);
      const elsewhere = table.iceberg.namespace !== table.schema || table.iceberg.name !== table.table;
      return {
        connectionId: lake.id,
        targetId: target.id,
        schema: table.schema,
        table: table.table,
        ...(tableId === undefined ? {} : { tableId }),
        snapshot: result.snapshot,
        ...(result.snapshotTime === undefined ? {} : { snapshotTime: result.snapshotTime }),
        ...(table.icebergSnapshot === undefined ? {} : { icebergSnapshot: table.icebergSnapshot }),
        ...(table.rows === undefined ? {} : { rows: table.rows }),
        ...(table.converted === undefined ? {} : { converted: table.converted }),
        copiedAt,
        ...(elsewhere ? { icebergNamespace: table.iceberg.namespace, icebergTable: table.iceberg.name } : {}),
        scope: scope.kind,
      };
    });
  // A copy of the whole lake or a schema replaces what an earlier copy of it to this target held; a table adds its own.
  if (scope.kind === 'lake') await deps.copies.replaceAll(lake.id, target.id, records);
  else if (scope.kind === 'schema')
    await deps.copies.replaceSchema(lake.id, target.id, scope.schema, records);
  else await deps.copies.save(records);
  ui[result.tables.some((table) => table.status === 'failed') ? 'error' : 'info'](
    resultText(result, records.length, lake.name, target.name),
  );
  return result;
}

/** What the copy did, for the message after it. */
function resultText(result: CopyResult, copied: number, lake: string, target: string): string {
  const failed = result.tables.filter((table) => table.status === 'failed');
  const converted = result.tables.reduce((sum, table) => sum + (table.converted?.length ?? 0), 0);
  const partitioned = result.tables.filter((table) => table.partitioned).length;
  const summary = [
    `Synced ${copied} of ${result.tables.length} ${result.tables.length === 1 ? 'table' : 'tables'} of "${lake}" at snapshot ${result.snapshot} to ${target}.`,
    ...(converted === 0
      ? []
      : [`${converted} ${converted === 1 ? 'column was' : 'columns were'} written as another type.`]),
    ...(partitioned === 0
      ? []
      : [`${partitioned} ${partitioned === 1 ? 'table is' : 'tables are'} partitioned as in the lake.`]),
  ].join(' ');
  if (failed.length === 0) return summary;
  const shown = failed
    .slice(0, 3)
    .map((table) => `${table.schema}.${table.table}: ${table.error ?? 'failed'}`);
  return `${summary} Failed: ${shown.join('; ')}${failed.length > 3 ? `; and ${failed.length - 3} more` : ''}.`;
}

/** Removes a target with its secret, after a confirmation; the records of its copies go too. Returns whether it did. */
export async function removeIcebergTargetFlow(
  ui: WizardUi,
  deps: {
    readonly targets: Pick<IcebergTargetStore, 'list' | 'remove'>;
    readonly copies: Pick<IcebergCopies, 'forget'>;
  },
): Promise<boolean> {
  const targets = deps.targets.list();
  if (targets.length === 0) {
    ui.info('There is no Iceberg target to remove.');
    return false;
  }
  const picked = await ui.pick(
    'Remove Iceberg Target',
    targets.map((target) => ({
      label: target.name,
      description: `${target.warehouse} at ${target.endpoint}`,
      value: target.id,
    })),
  );
  const target = targets.find((candidate) => candidate.id === picked);
  if (!target) return false;
  const confirmed = await ui.confirm(
    `Remove the Iceberg target "${target.name}"? Its stored sign-in and aantje's records of the copies are deleted; the Iceberg tables stay in the catalog.`,
    'Remove',
  );
  if (!confirmed) return false;
  await deps.targets.remove(target.id);
  await deps.copies.forget({ targetId: target.id });
  return true;
}
