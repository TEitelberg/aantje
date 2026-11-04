import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import { qualifiedName } from '../../src/catalog/ddl';
import type { ConnectionProfile } from '../../src/connections/profile';
import { setupStatements } from '../../src/data/attach';
import { instanceOptions } from '../../src/data/instance';
import type { DataAccess } from '../../src/data/types';
import { buildNotebook } from '../../src/notebook/build';
import type { NotebookCell } from '../../src/notebook/build';

const execFileAsync = promisify(execFile);

const IMAGE = 'python:3.12-slim';
const NAME = `aantje-test-nb-${randomBytes(4).toString('hex')}`;
const DATA_FIXTURE = fileURLToPath(new URL('../fixtures/data', import.meta.url));
const INFRASTRUCTURE_EXIT_CODES = new Set([3, 4]);

// The container downloads packages and DuckDB extensions, so the run is opt-in like the Postgres tests.
const skipReason = ((): string | undefined => {
  if (process.env.AANTJE_NOTEBOOK !== '1' && process.env.AANTJE_POSTGRES !== '1') {
    return 'set AANTJE_NOTEBOOK=1 (or use npm run test:full) to run it (needs Docker and network access)';
  }
  return undefined;
})();
if (skipReason !== undefined) {
  console.info(`The notebook execution tests are skipped: ${skipReason}.`);
}

/** Runs the cells of the notebooks in Python. It stops with exit code 3 when DuckDB extensions cannot be installed. */
const HARNESS = String.raw`
import ast
import getpass
import json
import os
import re
import shutil
import sys
import traceback
import types

import duckdb as real_duckdb

try:
    boot = real_duckdb.connect()
    for name in ('ducklake', 'sqlite'):
        boot.execute('INSTALL ' + name)
    boot.close()
except Exception as error:
    print('INFRA: ' + repr(error))
    sys.exit(3)

cases = json.load(open('/case/cases.json'))
shutil.copytree('/fixture', '/work')
os.chdir('/work')


TICK = chr(96)


def run_cell(source, namespace):
    """Runs a cell like Jupyter: magics are dropped, the value of the last expression is returned."""
    tree = ast.parse('\n'.join(line for line in source.split('\n') if not line.startswith('%')))
    last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
    exec(compile(tree, '<cell>', 'exec'), namespace)
    if last is not None:
        return eval(compile(ast.Expression(last.value), '<cell>', 'eval'), namespace)
    return None


def run_cells(cells, namespace):
    result = None
    for cell in cells:
        if cell['kind'] == 'code':
            result = run_cell(cell['source'], namespace)
    return result


def refuse(prompt=''):
    raise AssertionError('unexpected prompt: ' + prompt)


class Relation:
    def __init__(self, recorder, query):
        recorder.queries.append(query)

    def df(self):
        return None

    def show(self):
        return None

    def fetchall(self):
        return []


class Recorder:
    def __init__(self, config):
        self.config = config
        self.statements = []
        self.queries = []

    def execute(self, sql):
        self.statements.append(sql)
        return self

    def sql(self, query):
        return Relation(self, query)


def prepare(statements):
    """Creates a DuckLake that the fixtures do not have, with a connection of its own that is closed afterwards."""
    maker = real_duckdb.connect()
    for statement in statements:
        maker.execute(statement)
    maker.close()


def real_case(case):
    getpass.getpass = refuse
    prepare(case['setup'])
    namespace = {'__name__': '__main__'}
    frame = run_cells(case['cells'], namespace)
    con = namespace['con']
    out = {'columns': list(frame.columns), 'ids': [int(value) for value in frame['id']]}
    out['schema'] = con.execute('SELECT current_schema()').fetchone()[0]
    snippets = re.findall(TICK + r'(con\.[^' + TICK + r']*)' + TICK, case['cells'][-1]['source'])
    out['snippets'] = len(snippets)
    for snippet in snippets:
        value = run_cell(snippet, namespace)
        if 'ducklake_snapshots' in snippet:
            out['snapshots'] = len(value)
    try:
        con.execute('DELETE FROM ' + case['target'])
        out['write'] = 'allowed'
    except Exception as error:
        out['write'] = str(error)
    return out


def stub_case(case):
    sys.modules['duckdb'] = stub = types.ModuleType('duckdb')
    recorders = []

    def connect(*args, config=None, **kwargs):
        recorders.append(Recorder(config))
        return recorders[-1]

    stub.connect = connect
    for name in ('PGPASSWORD', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'):
        os.environ.pop(name, None)
    os.environ.update(case['env'])
    prompts = []

    def answer(prompt=''):
        prompts.append(prompt)
        return case['answers'][prompt]

    getpass.getpass = answer
    namespace = {'__name__': '__main__'}
    try:
        run_cells(case['cells'], namespace)
    finally:
        sys.modules['duckdb'] = real_duckdb
    return {
        'statements': recorders[0].statements,
        'config': recorders[0].config,
        'queries': recorders[0].queries,
        'prompts': prompts,
        'variables': {name: namespace.get(name) for name in case['variables']},
    }


def run(case, function):
    try:
        return function(case)
    except BaseException:
        return {'error': traceback.format_exc()}


results = {
    'real': {case['name']: run(case, real_case) for case in cases['real']},
    'stub': {case['name']: run(case, stub_case) for case in cases['stub']},
    'syntax': {},
}
for case in cases['real'] + cases['stub']:
    for index, cell in enumerate(case['cells']):
        if cell['kind'] == 'code':
            try:
                ast.parse('\n'.join(line for line in cell['source'].split('\n') if not line.startswith('%')))
            except SyntaxError as error:
                results['syntax'][case['name'] + '/' + str(index)] = str(error)
print('RESULT:' + json.dumps(results))
`;

interface Scenario {
  readonly name: string;
  readonly profile: ConnectionProfile;
  readonly snapshot?: number;
  readonly s3?: DataAccess['s3'];
  readonly credentials?: { keyId: string; secretKey: string };
  readonly password?: string;
  readonly extensionDirectory?: string;
  /** The secrets are typed at a prompt instead of coming from the environment. */
  readonly prompted?: boolean;
  /** Only these secrets come from the environment; the others are typed at a prompt. */
  readonly environment?: readonly string[];
  readonly table?: { schema: string; table: string };
}

const TABLE = { schema: 'sales', table: 'orders' };
const sqliteAt = (path: string): ConnectionProfile => ({ id: 's', name: 'sqlite', kind: 'sqlite', path });
const duckdbAt = (path: string): ConnectionProfile => ({ id: 'd', name: 'duckdb', kind: 'duckdb', path });
const postgres = (
  extra: Partial<Extract<ConnectionProfile, { kind: 'postgres' }>> = {},
): ConnectionProfile => ({
  id: 'p',
  name: 'pg',
  kind: 'postgres',
  host: 'db.example.com',
  port: 5433,
  database: 'lake',
  user: 'reader',
  ...extra,
});

const SCENARIOS: readonly Scenario[] = [
  { name: 'sqlite-latest', profile: sqliteAt('lake.sqlite') },
  {
    name: 'sqlite-pinned-minio-http',
    profile: sqliteAt('lake.sqlite'),
    snapshot: 5,
    s3: { endpoint: 'http://localhost:9000', region: 'us-east-1', urlStyle: 'path' },
    credentials: { keyId: 'AKIA', secretKey: "s3cr'et" },
  },
  {
    name: 'sqlite-endpoint-without-scheme-prompted',
    profile: sqliteAt('lake.sqlite'),
    s3: { endpoint: 'minio.local:9000' },
    credentials: { keyId: 'prompted-id', secretKey: 'prompted-secret' },
    prompted: true,
  },
  {
    name: 'duckdb-pinned-extension-directory-aws-default',
    profile: duckdbAt('/data/lake.duckdb'),
    snapshot: 6,
    extensionDirectory: '/opt/duckdb/extensions',
    credentials: { keyId: 'AKIA', secretKey: 'secret' },
  },
  {
    name: 'postgres-tls-schema-snapshot-https',
    profile: postgres({ ssl: true, metadataSchema: 'lake_meta' }),
    snapshot: 9,
    password: 'p\'w\\d"x',
    s3: { endpoint: 'https://s3.example.com/', region: 'eu-central-1', urlStyle: 'vhost' },
    credentials: { keyId: 'AKIA', secretKey: 'secret' },
  },
  {
    name: 'postgres-plain-password-prompted',
    profile: postgres(),
    password: 'typed-password',
    prompted: true,
  },
  { name: 'postgres-trust-login-empty-password', profile: postgres(), password: '', prompted: true },
  { name: 'sqlite-pinned-snapshot-zero', profile: sqliteAt('lake.sqlite'), snapshot: 0 },
  {
    name: 'sqlite-endpoint-key-id-from-environment-secret-prompted',
    profile: sqliteAt('lake.sqlite'),
    s3: { endpoint: 'http://localhost:9000' },
    credentials: { keyId: 'AKIA', secretKey: 'typed-secret' },
    environment: ['AWS_ACCESS_KEY_ID'],
  },
  {
    // Only http and https are schemes; anything else belongs to the host, as in setupStatements.
    name: 'sqlite-endpoint-with-another-scheme',
    profile: sqliteAt('lake.sqlite'),
    s3: { endpoint: 'ftp://minio.local:9000/' },
    credentials: { keyId: 'AKIA', secretKey: 'secret' },
  },
  {
    name: 'postgres-hostile-values',
    profile: postgres({
      host: "h'ost\\",
      database: 'd"b',
      user: "u' + PG_PASSWORD + '",
      ssl: true,
      metadataSchema: "m'x\\",
    }),
    password: 'p\'\\"w',
    s3: { endpoint: "HTTP://e'x\\:9000/", region: "r\\'", urlStyle: 'vhost' },
    credentials: { keyId: "k'\\", secretKey: "s'\\" },
    extensionDirectory: "d'\\ir",
  },
  {
    name: 'duckdb-hostile-path-and-table',
    profile: duckdbAt("/data/o'neil/日本 \\lake.duckdb"),
    table: { schema: "s'\\", table: '日本 "t"\t😀' },
  },
  {
    name: 'windows-path-with-quote',
    profile: sqliteAt(String.raw`C:\Users\O'Neil\"my" lake.sqlite`),
    table: { schema: 'we"ird', table: "it's\\a table" },
  },
];

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  "'",
  '"',
  '\\',
  '`',
  ' ',
  '\n',
  '\r',
  '\t',
  '\u0085',
  '\u2028',
  '\u202e',
  'ä',
  '日',
  '😀',
  ';',
  '%',
  '{',
  '}',
  '-',
  'x',
  '1',
];

/** Random hostile text that starts and ends with a letter, because the settings are trimmed. */
function fuzzScenarios(count: number): Scenario[] {
  const next = random(20261030);
  // An endpoint is a host name: no line breaks, which the data package's scheme pattern does not accept either.
  const text = (singleLine = false): string => {
    const alphabet = singleLine
      ? ALPHABET.filter((character) => !'\n\r\u2028'.includes(character))
      : ALPHABET;
    const length = Math.floor(next() * 9);
    const middle = Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');
    return `a${middle}b`;
  };
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
  return Array.from({ length: count }, (_, index): Scenario => {
    const kind = pick(['sqlite', 'duckdb', 'postgres'] as const);
    const endpoint = pick(['', `${text(true)}:9000`, `http://${text(true)}:9000`, `HTTPS://${text(true)}/`]);
    return {
      name: `fuzz-${index}-${kind}`,
      profile:
        kind === 'postgres'
          ? postgres({
              host: text(),
              database: text(),
              user: text(),
              ssl: next() < 0.5,
              ...(next() < 0.5 ? { metadataSchema: text() } : {}),
            })
          : kind === 'sqlite'
            ? sqliteAt(text())
            : duckdbAt(text()),
      table: { schema: text(), table: text() },
      snapshot: next() < 0.5 ? Math.floor(next() * 100) : undefined,
      password: kind === 'postgres' ? text() : undefined,
      s3: { endpoint, region: pick(['', text()]), urlStyle: pick([undefined, 'path', 'vhost'] as const) },
      credentials: endpoint !== '' || next() < 0.5 ? { keyId: text(), secretKey: text() } : undefined,
      extensionDirectory: pick([undefined, text()]),
    };
  });
}

interface StubCase {
  readonly name: string;
  readonly cells: readonly NotebookCell[];
  readonly env: Record<string, string>;
  readonly answers: Record<string, string>;
  readonly variables: readonly string[];
  readonly expected: {
    readonly statements: string[];
    readonly config: Record<string, string> | null;
    readonly prompts: string[];
    readonly variables: Record<string, unknown>;
  };
}

const LOCK = 'SET lock_configuration = true';

/** The temporary directory is unique per engine (and per machine): both sides are compared by its kind, not its name. */
const TEMP_DIRECTORY = '<private temporary directory>';

function maskTemporaryDirectory(
  config: Record<string, string> | null | undefined,
): Record<string, string> | null | undefined {
  const directory = config?.temp_directory;
  return config && directory !== undefined && /\/aantje-duckdb-[^/]+$/.test(directory)
    ? { ...config, temp_directory: TEMP_DIRECTORY }
    : config;
}

/** What the configuration cell leaves behind; a variable the profile kind does not define is None. */
function expectedVariables(
  profile: ConnectionProfile,
  snapshot: number | undefined,
  table: { schema: string; table: string },
): Record<string, unknown> {
  const postgresOnly = profile.kind === 'postgres';
  return {
    CATALOG_PATH: 'path' in profile ? profile.path : null,
    PG_PASSWORD: null,
    S3_KEY_ID: null,
    S3_SECRET_KEY: null,
    pg: null,
    s3: null,
    endpoint: null,
    use_ssl: null,
    PG_HOST: postgresOnly ? profile.host : null,
    PG_DATABASE: postgresOnly ? profile.database : null,
    PG_USER: postgresOnly ? profile.user : null,
    PG_SSL: postgresOnly ? profile.ssl === true : null,
    PG_METADATA_SCHEMA: postgresOnly ? (profile.metadataSchema ?? null) : null,
    SNAPSHOT: snapshot ?? null,
    QUERY: `SELECT * FROM lake.${qualifiedName(table.schema, table.table)} LIMIT 1000`,
  };
}

function stubCase(scenario: Scenario): StubCase {
  const table = scenario.table ?? TABLE;
  const s3 = scenario.s3 ?? {};
  const spec = {
    connectionName: scenario.profile.name,
    profile: scenario.profile,
    table,
    snapshot: scenario.snapshot,
    s3,
    extensionDirectory: scenario.extensionDirectory,
    generatedOn: '2026-10-30',
  };
  const access: DataAccess = {
    profile: scenario.profile,
    password: scenario.password,
    snapshot: scenario.snapshot,
    s3,
    s3Credentials: scenario.credentials,
    extensionDirectory: scenario.extensionDirectory,
  };
  const env: Record<string, string> = {};
  const answers: Record<string, string> = {};
  const prompts: string[] = [];
  const fromEnvironment = (name: string): boolean =>
    scenario.environment ? scenario.environment.includes(name) : !scenario.prompted;
  const secrets: [string, string, string | undefined][] = [
    ['PGPASSWORD', 'PostgreSQL password: ', scenario.password],
    ['AWS_ACCESS_KEY_ID', 'S3 access key id: ', scenario.credentials?.keyId],
    ['AWS_SECRET_ACCESS_KEY', 'S3 secret access key: ', scenario.credentials?.secretKey],
  ];
  for (const [name, prompt, value] of secrets) {
    if (value === undefined) {
      continue;
    }
    if (fromEnvironment(name)) {
      env[name] = value;
    } else {
      answers[prompt] = value;
    }
  }
  // The notebook asks for a secret only when it has none: the password always, the S3 keys with an endpoint.
  const endpointSet = (s3.endpoint ?? '').trim() !== '';
  for (const [name, prompt, value, needsEndpoint] of [
    ['PGPASSWORD', 'PostgreSQL password: ', scenario.password, false],
    ['AWS_ACCESS_KEY_ID', 'S3 access key id: ', scenario.credentials?.keyId, true],
    ['AWS_SECRET_ACCESS_KEY', 'S3 secret access key: ', scenario.credentials?.secretKey, true],
  ] as const) {
    if (value !== undefined && (endpointSet || !needsEndpoint) && !fromEnvironment(name)) {
      prompts.push(prompt);
    }
  }
  return {
    name: scenario.name,
    cells: buildNotebook(spec),
    env,
    answers,
    variables: Object.keys(expectedVariables(scenario.profile, scenario.snapshot, table)),
    expected: {
      // The notebook does not lock the configuration: the user may keep working in the session.
      statements: [...setupStatements(access).filter((statement) => statement !== LOCK), 'USE lake'],
      config: { ...instanceOptions(access), temp_directory: TEMP_DIRECTORY },
      prompts,
      variables: expectedVariables(scenario.profile, scenario.snapshot, table),
    },
  };
}

interface RealCase {
  readonly name: string;
  readonly cells: readonly NotebookCell[];
  /** SQL that creates the catalog of the case; empty for the checked-in data fixture. */
  readonly setup: readonly string[];
  /** The table that the write attempt targets. */
  readonly target: string;
}

const FIXTURE_CASES: readonly RealCase[] = [
  { name: 'sqlite-latest', path: 'data-catalog.sqlite', snapshot: undefined, kind: 'sqlite' },
  { name: 'sqlite-before-delete', path: 'data-catalog.sqlite', snapshot: 5, kind: 'sqlite' },
  { name: 'duckdb-latest', path: 'data-catalog.duckdb', snapshot: undefined, kind: 'duckdb' },
  { name: 'duckdb-before-delete', path: 'data-catalog.duckdb', snapshot: 5, kind: 'duckdb' },
].map(({ name, path, snapshot, kind }) => ({
  name,
  setup: [],
  target: 'lake.sales.orders',
  cells: buildNotebook({
    connectionName: name,
    profile: { id: name, name, kind: kind as 'sqlite' | 'duckdb', path },
    table: TABLE,
    snapshot,
    shownSnapshot: snapshot ?? 13,
    s3: {},
    generatedOn: '2026-10-30',
  }),
}));

// A schema named like the catalog it lives in: "lake"."items" is ambiguous for DuckDB once `USE lake` has run.
const SCHEMA_LIKE_CATALOG: RealCase = {
  name: 'schema-named-like-the-catalog',
  setup: [
    'INSTALL ducklake',
    'LOAD ducklake',
    'INSTALL sqlite',
    'LOAD sqlite',
    "ATTACH 'ducklake:sqlite:/work/schema-lake.sqlite' AS maker (DATA_PATH '/work/schema-lake-files/')",
    'CREATE SCHEMA maker.lake',
    'CREATE TABLE maker.lake.items AS SELECT * FROM range(1, 4) t(id)',
  ],
  target: 'lake.lake.items',
  cells: buildNotebook({
    connectionName: 'schema-lake',
    profile: { id: 'schema-lake', name: 'schema-lake', kind: 'sqlite', path: '/work/schema-lake.sqlite' },
    table: { schema: 'lake', table: 'items' },
    s3: {},
    generatedOn: '2026-10-30',
  }),
};

// A lake whose schema main was dropped: `USE lake` fails there, and the notebook falls back to the first schema.
const WITHOUT_MAIN: RealCase = {
  name: 'lake-without-main',
  setup: [
    'INSTALL ducklake',
    'LOAD ducklake',
    'INSTALL sqlite',
    'LOAD sqlite',
    "ATTACH 'ducklake:sqlite:/work/no-main.sqlite' AS maker (DATA_PATH '/work/no-main-files/')",
    'CREATE SCHEMA maker.silver',
    'CREATE TABLE maker.silver.items AS SELECT * FROM range(1, 4) t(id)',
    'DROP SCHEMA maker.main',
  ],
  target: 'lake.silver.items',
  cells: buildNotebook({
    connectionName: 'no-main',
    profile: { id: 'no-main', name: 'no-main', kind: 'sqlite', path: '/work/no-main.sqlite' },
    table: { schema: 'silver', table: 'items' },
    s3: {},
    generatedOn: '2026-10-30',
  }),
};

const REAL_CASES: readonly RealCase[] = [...FIXTURE_CASES, SCHEMA_LIKE_CATALOG, WITHOUT_MAIN];

interface Results {
  readonly real: Record<
    string,
    {
      error?: string;
      columns: string[];
      ids: number[];
      schema: string;
      snippets: number;
      snapshots: number;
      write: string;
    }
  >;
  readonly stub: Record<
    string,
    {
      error?: string;
      statements: string[];
      config: Record<string, string> | null;
      queries: string[];
      prompts: string[];
      variables: Record<string, unknown>;
    }
  >;
  readonly syntax: Record<string, string>;
}

let results: Results | undefined;
let infrastructureProblem: string | undefined;
const stubCases = [...SCENARIOS, ...fuzzScenarios(60)].map(stubCase);

function problemOf(error: unknown): string {
  const { stdout, stderr, message } = error as { stdout?: string; stderr?: string; message: string };
  return [message, stdout, stderr].filter(Boolean).join('\n').slice(-4000);
}

describe.skipIf(skipReason !== undefined)(
  'the generated notebook executed in Python 3.12 with DuckDB 2.0.0',
  () => {
    let directory = '';

    beforeAll(async () => {
      try {
        await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}']);
      } catch {
        infrastructureProblem = 'Docker is not available';
        return;
      }
      directory = mkdtempSync(join(tmpdir(), 'aantje-nb-'));
      writeFileSync(join(directory, 'run.py'), HARNESS);
      writeFileSync(
        join(directory, 'cases.json'),
        JSON.stringify({
          real: REAL_CASES,
          stub: stubCases.map(({ name, cells, env, answers, variables }) => ({
            name,
            cells,
            env,
            answers,
            variables,
          })),
        }),
      );
      try {
        const { stdout } = await execFileAsync(
          'docker',
          [
            ...['run', '--name', NAME, '--rm'],
            ...['-v', `${DATA_FIXTURE}:/fixture:ro`, '-v', `${directory}:/case:ro`],
            ...['-e', 'PYTHONDONTWRITEBYTECODE=1', IMAGE],
            ...[
              'sh',
              '-c',
              'pip install --quiet --no-cache-dir --root-user-action=ignore duckdb==2.0.0 pandas || exit 4; python /case/run.py',
            ],
          ],
          { maxBuffer: 64 * 1024 * 1024, timeout: 280_000 },
        );
        const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith('RESULT:'));
        results = JSON.parse(line?.slice('RESULT:'.length) ?? 'null') as Results;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'number' && INFRASTRUCTURE_EXIT_CODES.has(code)) {
          infrastructureProblem = `the container could not install packages or DuckDB extensions (exit code ${code}); network access is needed`;
          return;
        }
        throw new Error(`The notebook run failed:\n${problemOf(error)}`, { cause: error });
      } finally {
        await execFileAsync('docker', ['rm', '-f', NAME]).catch(() => undefined);
      }
    }, 300_000);

    afterAll(() => {
      // Exactly the directory created above, under the system temp directory.
      if (directory.startsWith(tmpdir()) && directory.includes('aantje-nb-')) {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    function available(context: TestContext): Results {
      if (infrastructureProblem !== undefined || results === undefined) {
        return context.skip(`skipped: ${infrastructureProblem ?? 'no result'}`);
      }
      return results;
    }

    it('reads the table of the SQLite DuckLake at the latest snapshot and one snapshot before the delete', (context) => {
      const { real } = available(context);
      expect(real['sqlite-latest']).toMatchObject({
        columns: ['id', 'customer', 'attrs', 'amount', 'created'],
        ids: [1, 3],
      });
      expect(real['sqlite-before-delete']).toMatchObject({ ids: [1, 2, 3] });
    });

    it('reads the table of the DuckDB DuckLake at the latest snapshot and one snapshot before the delete', (context) => {
      const { real } = available(context);
      expect(real['duckdb-latest']).toMatchObject({
        columns: ['id', 'customer', 'attrs', 'amount', 'created'],
        ids: [1, 3],
      });
      expect(real['duckdb-before-delete']).toMatchObject({ ids: [1, 2, 3] });
    });

    it('runs every snippet of the next steps cell, and the snapshot list shows all 14 snapshots', (context) => {
      const { real } = available(context);
      expect(real['sqlite-latest']).toMatchObject({ snippets: 3, snapshots: 14 });
    });

    it('attaches read-only: a write is refused', (context) => {
      const { real } = available(context);
      for (const result of Object.values(real)) {
        expect(result.write).toMatch(/read[- ]only/i);
      }
    });

    it('finds the table of a schema that is named like the catalog', (context) => {
      const { real } = available(context);
      expect(real['schema-named-like-the-catalog']).toMatchObject({ ids: [1, 2, 3] });
    });

    it('reads a lake without the schema main, with its first schema as the default', (context) => {
      const { real } = available(context);
      expect(real['lake-without-main']).toMatchObject({ ids: [1, 2, 3], snippets: 3, schema: 'silver' });
    });

    it('runs without any prompt when only a local file catalog is used', (context) => {
      const { real } = available(context);
      for (const [name, result] of Object.entries(real)) {
        expect(result.error, name).toBeUndefined();
      }
    });

    it('produces valid Python in every code cell', (context) => {
      expect(available(context).syntax).toEqual({});
    });

    it('builds the SQL of the data package, the variables and the prompts for every kind of profile', (context) => {
      const { stub } = available(context);
      // All differences at once: a change of the notebook shows which scenarios it breaks.
      const differences = stubCases
        .map(({ name, expected }) => {
          const result = stub[name];
          return {
            name,
            actual: {
              error: result?.error ?? null,
              statements: result?.statements,
              config: maskTemporaryDirectory(result?.config),
              queries: result?.queries,
              prompts: result?.prompts,
              variables: result?.variables,
            },
            expected: { error: null, ...expected, queries: [expected.variables.QUERY] },
          };
        })
        .filter(({ actual, expected }) => !isDeepStrictEqual(actual, expected));
      expect(differences).toEqual([]);
    });
  },
);
