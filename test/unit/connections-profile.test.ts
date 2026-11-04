import { describe, expect, it } from 'vitest';
import type { ConnectionProfile } from '../../src/connections/profile';
import {
  boundPassword,
  isNameTaken,
  parseProfiles,
  passwordSecretValue,
  toSettingEntry,
  validateHost,
  validatePath,
  validatePort,
  validateQuackHost,
  validateRequired,
} from '../../src/connections/profile';

/** What an administrator or a user may have written into `aantje.connections`, good and bad entries mixed. */
const SETTING: unknown = [
  { name: 'Example Lakehouse', kind: 'postgres', host: 'postgres', database: 'ducklake', user: 'ducklake' },
  {
    id: 'lab',
    name: 'Lab (TLS)',
    kind: 'postgres',
    host: 'lab.example.org',
    port: 6543,
    database: 'lake',
    user: 'reader',
    metadataSchema: 'ducklake_meta',
    ssl: true,
  },
  {
    name: '  Local SQLite  ',
    kind: 'sqlite',
    path: ' D:\\data\\ducklake.sqlite ',
    note: 'unknown properties are ignored',
  },
  { name: 'Local DuckDB', kind: 'duckdb', path: '/data/ducklake.duckdb', readOnly: true },
  { name: 'EXAMPLE LAKEHOUSE', kind: 'sqlite', path: '/other.sqlite' },
  { name: 'No host', kind: 'postgres', database: 'lake', user: 'reader' },
  { name: 'Bad port', kind: 'postgres', host: 'db', port: 70000, database: 'lake', user: 'reader' },
  { name: 'Port as text', kind: 'postgres', host: 'db', port: '5432', database: 'lake', user: 'reader' },
  { name: 'MySQL', kind: 'mysql', host: 'db' },
  { name: 'No path', kind: 'duckdb', path: '  ' },
  { kind: 'sqlite', path: '/x.sqlite' },
  'oops',
  null,
  [1, 2],
  { id: 'lab', name: 'Lab copy', kind: 'sqlite', path: '/lab.sqlite' },
  { name: 'TLS as text', kind: 'postgres', host: 'db', database: 'lake', user: 'reader', ssl: 'true' },
  { name: 42, kind: 'sqlite', path: '/x' },
  { name: 'Path as number', kind: 'sqlite', path: 5 },
  { name: 'Blank id', id: '  ', kind: 'sqlite', path: '/a' },
  { name: 'Id as number', id: 7, kind: 'postgres', host: 'db', database: 'lake', user: 'reader' },
  {
    name: 'Blank schema',
    kind: 'postgres',
    host: 'db',
    database: 'lake',
    user: 'reader',
    metadataSchema: ' ',
  },
  {
    name: 'Schema as number',
    kind: 'postgres',
    host: 'db',
    database: 'lake',
    user: 'reader',
    metadataSchema: 5,
  },
  { name: 'Read-only as text', kind: 'sqlite', path: '/ro.sqlite', readOnly: 'true' },
];

/** The index of each skipped entry and the datum its problem must name. */
const SKIPPED: [number, string][] = [
  [4, 'EXAMPLE LAKEHOUSE'],
  [5, 'host'],
  [6, 'ort'],
  [7, 'port'],
  [8, 'kind'],
  [9, 'ath'],
  [10, 'name'],
  [11, 'object'],
  [12, 'object'],
  [13, 'object'],
  [14, 'lab'],
  [15, 'ssl'],
  [16, 'name'],
  [17, 'path'],
  [18, 'd must not be empty'],
  [19, 'id'],
  [20, 'chema'],
  [21, 'metadataSchema'],
  [22, 'readOnly'],
];

describe('parsing the aantje.connections setting', () => {
  it('keeps the usable profiles (trimmed, with defaults) and skips every bad entry, naming its index and field', () => {
    const { profiles, problems } = parseProfiles(SETTING);

    expect(profiles).toStrictEqual([
      {
        id: 'example-lakehouse',
        name: 'Example Lakehouse',
        kind: 'postgres',
        host: 'postgres',
        port: 5432,
        database: 'ducklake',
        user: 'ducklake',
        ssl: true,
      },
      {
        id: 'lab',
        name: 'Lab (TLS)',
        kind: 'postgres',
        host: 'lab.example.org',
        port: 6543,
        database: 'lake',
        user: 'reader',
        ssl: true,
        metadataSchema: 'ducklake_meta',
      },
      { id: 'local-sqlite', name: 'Local SQLite', kind: 'sqlite', path: 'D:\\data\\ducklake.sqlite' },
      {
        id: 'local-duckdb',
        name: 'Local DuckDB',
        kind: 'duckdb',
        path: '/data/ducklake.duckdb',
        readOnly: true,
      },
    ]);
    expect(problems.map((problem) => Number(/\[(\d+)\]/.exec(problem)?.[1]))).toStrictEqual(
      SKIPPED.map(([index]) => index),
    );
    for (const [position, [, datum]] of SKIPPED.entries()) {
      expect(problems[position]).toContain(datum);
    }

    // A missing setting is no connections; a setting that is not an array is one problem.
    expect(parseProfiles(undefined)).toStrictEqual({ profiles: [], problems: [] });
    expect(parseProfiles(null)).toStrictEqual({ profiles: [], problems: [] });
    const notAnArray = parseProfiles({ name: 'Lab', kind: 'sqlite', path: '/lab.sqlite' });
    expect(notAnArray.profiles).toStrictEqual([]);
    expect(notAnArray.problems).toHaveLength(1);

    // readOnly is kept for every kind and left out when the entry has none.
    const readOnly = parseProfiles([
      { name: 'Lite', kind: 'sqlite', path: '/l.sqlite', readOnly: false },
      { name: 'Duck', kind: 'duckdb', path: '/d.duckdb', readOnly: true },
      { name: 'Pg', kind: 'postgres', host: 'db', database: 'lake', user: 'reader', readOnly: true },
      { name: 'None', kind: 'sqlite', path: '/n.sqlite' },
    ]);
    expect(readOnly.problems).toStrictEqual([]);
    expect(readOnly.profiles.map((profile) => profile.readOnly)).toStrictEqual([
      false,
      true,
      true,
      undefined,
    ]);
    expect(readOnly.profiles[3]).not.toHaveProperty('readOnly');
  });
});

describe('profile and setting entry', () => {
  const sslOf = (host: string, ssl?: unknown): unknown =>
    (
      parseProfiles([
        {
          name: 'Lake',
          kind: 'postgres',
          host,
          database: 'lake',
          user: 'reader',
          ...(ssl === undefined ? {} : { ssl }),
        },
      ]).profiles[0] as { ssl?: boolean } | undefined
    )?.ssl;

  const profiles: ConnectionProfile[] = [
    {
      id: 'example',
      name: 'Example',
      kind: 'postgres',
      host: 'postgres',
      port: 5432,
      database: 'ducklake',
      user: 'ducklake',
      ssl: false,
    },
    {
      id: 'lab',
      name: 'Lab',
      kind: 'postgres',
      host: 'lab.example.org',
      port: 6543,
      database: 'lake',
      user: 'reader',
      metadataSchema: 'ducklake_meta',
      ssl: true,
    },
    { id: 'file', name: 'File', kind: 'sqlite', path: 'D:\\data\\ducklake.sqlite' },
    { id: 'duck-ro', name: 'Duck RO', kind: 'duckdb', path: '/data/ro.duckdb', readOnly: true },
    { id: 'lite-rw', name: 'Lite RW', kind: 'sqlite', path: '/data/rw.sqlite', readOnly: false },
    {
      id: 'pg-ro',
      name: 'Pg RO',
      kind: 'postgres',
      port: 5432,
      host: 'postgres',
      database: 'ducklake',
      user: 'ducklake',
      ssl: false,
      readOnly: true,
    },
  ];

  it('defaults TLS by host and writes it back, reads back what it wrote for every profile shape, and never writes a password', () => {
    for (const host of [
      'db.example.com',
      'postgres',
      '10.0.0.5',
      '127.0.0.2',
      'localhost.example.com',
      '::2',
    ]) {
      expect(sslOf(host), host).toBe(true);
    }
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]']) {
      expect(sslOf(host), host).toBe(false);
    }
    expect(sslOf('db.example.com', false)).toBe(false);
    expect(sslOf('localhost', true)).toBe(true);

    const [profile] = parseProfiles([
      { name: 'Lake', kind: 'postgres', host: 'db.example.com', database: 'lake', user: 'reader' },
    ]).profiles;
    expect((toSettingEntry(profile as ConnectionProfile) as { ssl: boolean }).ssl).toBe(true);

    // Reads back what it wrote for every shape of profile, writes readOnly only when the profile has it.
    for (const profile of profiles) {
      expect(parseProfiles([toSettingEntry(profile)]), profile.name).toStrictEqual({
        profiles: [profile],
        problems: [],
      });
    }
    expect(toSettingEntry(profiles[2] as ConnectionProfile)).not.toHaveProperty('readOnly');

    const common = { id: 'x', name: 'X', password: 'hunter2', extra: 'x' };
    const postgres = {
      ...common,
      kind: 'postgres' as const,
      host: 'postgres',
      port: 5432,
      database: 'lake',
      user: 'app',
    };
    const file = { ...common, kind: 'sqlite' as const, path: '/p' };

    expect(JSON.stringify(toSettingEntry(postgres))).not.toMatch(/hunter2|extra/);
    expect(toSettingEntry(file)).toStrictEqual({ id: 'x', name: 'X', kind: 'sqlite', path: '/p' });
  });
});

describe('connection ids', () => {
  const sqliteNamed = (name: string, path: string): unknown => ({ name, kind: 'sqlite', path });
  const idsOf = (entries: unknown[]): string[] => parseProfiles(entries).profiles.map(({ id }) => id);

  it('derives a slug from the name, numbers colliding slugs and reserves explicit ids, also of skipped entries', () => {
    expect(
      idsOf([
        sqliteNamed('Prod DB', '/a'),
        sqliteNamed('prod-db', '/b'),
        sqliteNamed('Prod_DB', '/c'),
        sqliteNamed('Café Münster', '/d'),
        sqliteNamed('\u65e5\u672c\u8a9e', '/e'),
        sqliteNamed('!!!', '/f'),
        sqliteNamed('Lab (TLS)', '/g'),
        sqliteNamed('(x) y', '/h'),
      ]),
    ).toStrictEqual([
      'prod-db',
      'prod-db-2',
      'prod-db-3',
      'cafe-munster',
      'connection',
      'connection-2',
      'lab-tls',
      'x-y',
    ]);

    const other = { name: 'Other', kind: 'sqlite', path: '/b' };
    expect(idsOf([sqliteNamed('Lab', '/a'), { id: 'lab', ...other }])).toStrictEqual(['lab-2', 'lab']);
    expect(idsOf([sqliteNamed('Lab', '/a'), { id: ' lab ', ...other }])).toStrictEqual(['lab-2', 'lab']);
    expect(idsOf([sqliteNamed('Lab', '/a'), { id: 'lab', name: 'Broken', kind: 'mysql' }])).toStrictEqual([
      'lab-2',
    ]);
    expect(idsOf([{ name: 'Prod', kind: 'sqlite' }, sqliteNamed('Prod', '/prod.sqlite')])).toStrictEqual([
      'prod',
    ]);
  });
});

describe('names and input validators', () => {
  it('finds a taken name ignoring case and spaces, skips the profile being edited, and validates each field', () => {
    const lab: ConnectionProfile = { id: 'a', name: 'lab', kind: 'sqlite', path: '/p' };
    for (const name of ['lab', ' Lab ', 'LAB']) {
      expect(isNameTaken(name, [lab]), name).toBe(true);
    }
    expect(isNameTaken('lab2', [lab])).toBe(false);
    expect(isNameTaken('lab', [lab], 'a')).toBe(false);

    // A validator answers `undefined` for an accepted value and a message for a rejected one.
    const rows: Array<[string, (value: string) => string | undefined, string[], string[]]> = [
      [
        'host',
        validateHost,
        ['db.example.org', '10.0.0.5', '::1', '/var/run/postgresql'],
        ['', '   ', 'db host', 'postgres://db.example.org/lake'],
      ],
      ['port', validatePort, ['5432', '1', '65535', ' 5433 '], ['0', '65536', '-1', '54.32', 'abc', '']],
      [
        'path',
        validatePath,
        ['D:\\data\\ducklake.sqlite', '/data/ducklake.duckdb'],
        ['', '   ', '"D:\\data\\ducklake.sqlite"', "'/data/ducklake.sqlite'", '  "D:\\data\\x.sqlite"  '],
      ],
      ['required', validateRequired('Database'), ['lake'], ['', '  ']],
    ];
    for (const [field, validate, accepted, rejected] of rows) {
      for (const value of accepted) {
        expect(validate(value), `${field} ${JSON.stringify(value)}`).toBeUndefined();
      }
      for (const value of rejected) {
        expect(validate(value), `${field} ${JSON.stringify(value)}`).toEqual(expect.any(String));
      }
    }
    expect(validateRequired('Database')('  ')).toContain('Database');
  });
});

describe('DuckDB + Quack profiles', () => {
  const FINGERPRINT = `6D:78:39:F0:DF:9D:D7:27:07:8E:9B:B1:3F:E0:78:52:1D:95:1F:4D:A2:67:75:8F:C9:28:2B:99:3E:0A:11:17`;

  it('defaults the port to 9494 and TLS to every host but the local machine, pins a fingerprint in one form, and keeps the entry through a save', () => {
    const { profiles, problems } = parseProfiles([
      { name: 'Served', kind: 'quack', host: 'duckdb' },
      { name: 'Local', kind: 'quack', host: 'localhost', port: 59494 },
      {
        name: 'Pinned',
        kind: 'quack',
        host: '10.0.0.5',
        ssl: true,
        fingerprint: FINGERPRINT.replaceAll(':', '').toLowerCase(),
      },
    ]);

    expect(problems).toStrictEqual([]);
    expect(profiles).toStrictEqual([
      { id: 'served', name: 'Served', kind: 'quack', host: 'duckdb', port: 9494, ssl: true },
      { id: 'local', name: 'Local', kind: 'quack', host: 'localhost', port: 59494, ssl: false },
      {
        id: 'pinned',
        name: 'Pinned',
        kind: 'quack',
        host: '10.0.0.5',
        port: 9494,
        ssl: true,
        fingerprint: FINGERPRINT,
      },
    ]);
    expect(parseProfiles(profiles.map(toSettingEntry)).profiles).toStrictEqual(profiles);
  });

  it('skips an entry with the host quack, a read-only switch, a fingerprint that is no SHA-256 or one without TLS', () => {
    const { profiles, problems } = parseProfiles([
      { name: 'Named quack', kind: 'quack', host: 'quack' },
      { name: 'Read-only', kind: 'quack', host: 'duckdb', readOnly: true },
      { name: 'Short pin', kind: 'quack', host: 'duckdb', fingerprint: 'AB:CD' },
      { name: 'Pin without TLS', kind: 'quack', host: 'duckdb', ssl: false, fingerprint: FINGERPRINT },
    ]);

    expect(profiles).toStrictEqual([]);
    expect(problems).toHaveLength(4);
    expect(validateQuackHost(' QUACK ')).toBeDefined();
    expect(validateQuackHost('quack-server')).toBeUndefined();
  });

  it('binds the token to host and port, so a password stored for the same server and port of a PostgreSQL entry is not sent', () => {
    const quack: ConnectionProfile = { id: 'q', name: 'q', kind: 'quack', host: 'db', port: 5432, ssl: true };
    const postgres: ConnectionProfile = {
      id: 'q',
      name: 'q',
      kind: 'postgres',
      host: 'db',
      port: 5432,
      database: 'lake',
      user: 'reader',
    };
    const stored = passwordSecretValue(quack, 'tok-1234');

    expect(boundPassword(stored, quack)).toBe('tok-1234');
    expect(boundPassword(stored, { ...quack, ssl: false, fingerprint: FINGERPRINT })).toBe('tok-1234');
    expect(boundPassword(stored, { ...quack, host: 'other' })).toBeUndefined();
    expect(boundPassword(stored, { ...quack, port: 9494 })).toBeUndefined();
    expect(boundPassword(stored, postgres)).toBeUndefined();
    expect(boundPassword(passwordSecretValue(postgres, 'pw-1234'), quack)).toBeUndefined();
  });
});
