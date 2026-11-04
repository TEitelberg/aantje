import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { AantjeError } from '../../src/errors';
import { createLogger, formatError, logFailure, SecretRegistry } from '../../src/log';
import { createOutputChannelLogger } from '../../src/log.vscode';

// The editor is the only thing that is replaced: a stand-in for it that records what reaches the "aantje" channel.
const editor = vi.hoisted(() => {
  const state = { opened: [] as unknown[][], written: [] as [string, string][], disposed: 0 };
  // Like the real API object, the methods depend on `this`: an unbound call must fail.
  class Channel {
    readonly written = state.written;
    info(message: string) {
      this.written.push(['info', message]);
    }
    warn(message: string) {
      this.written.push(['warn', message]);
    }
    error(message: string) {
      this.written.push(['error', message]);
    }
    dispose() {
      state.disposed++;
    }
  }
  const channel = new Channel();
  return {
    state,
    createOutputChannel: (...args: unknown[]) => {
      state.opened.push(args);
      return channel;
    },
  };
});
vi.mock('vscode', () => ({ window: { createOutputChannel: editor.createOutputChannel } }));

// A realistic Postgres password with the characters that break URLs and connection strings.
const PASSWORD = 'p@ss:w/rd#1 %';
// The same password as a URL builder writes it into `postgres://user:<password>@host`.
const PASSWORD_IN_URL = 'p%40ss%3Aw%2Frd%231%20%25';

function registryWith(...passwords: string[]): SecretRegistry {
  const secrets = new SecretRegistry();
  for (const password of passwords) {
    secrets.add(password);
  }
  return secrets;
}

function loggerWith(secrets: SecretRegistry) {
  const entries: [string, string][] = [];
  const log = createLogger((level, message) => entries.push([level, message]), secrets);
  return { log, entries };
}

/** Drops the stack frames, which differ between machines, and keeps the line that names each error. */
function withoutFrames(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s+at /.test(line))
    .join('\n');
}

describe('SecretRegistry', () => {
  it('masks registered and unregistered passwords in every form a message can carry them, and leaves other text alone', () => {
    const registered: [string, string][] = [
      [`Login of "app" failed with ${PASSWORD}.`, 'Login of "app" failed with ***.'],
      [`${PASSWORD} and ${PASSWORD} again`, '*** and *** again'],
      [`postgres://app:${PASSWORD}@db:5432/lake`, 'postgres://app:***@db:5432/lake'],
      [`postgres://app:${PASSWORD_IN_URL}@db:5432/lake`, 'postgres://app:***@db:5432/lake'],
      [
        `host=db port=5432 user=app password=${PASSWORD} dbname=lake`,
        'host=db port=5432 user=app password=*** dbname=lake',
      ],
      [`host=db password='${PASSWORD}' dbname=lake`, 'host=db password=*** dbname=lake'],
      // The percent-encoded form next to a key that is not called "password".
      [`?user=app&pwd=${PASSWORD_IN_URL}&sslmode=require`, '?user=app&pwd=***&sslmode=require'],
    ];
    for (const [text, expected] of registered) {
      expect(registryWith(PASSWORD).redact(text), text).toBe(expected);
    }

    // The JSON-escaped form, as a serialised message holds it.
    const escaped = 'pa"ss\\w\nord';
    const json = JSON.stringify({ error: `login failed for ${escaped}` });
    expect(json).not.toContain(escaped);
    expect(registryWith(escaped).redact(json)).toBe('{"error":"login failed for ***"}');

    // The form with doubled single quotes, as an engine echoes a SQL literal.
    expect(registryWith("it's-a-secret").redact("CREATE SECRET s (SECRET 'it''s-a-secret')")).toBe(
      "CREATE SECRET s (SECRET '***')",
    );

    // Several secrets, prefixes of each other in either order, secrets added later, and secrets are literal text.
    expect(registryWith(PASSWORD, 'hunter2-prod').redact(`dev ${PASSWORD}, prod hunter2-prod`)).toBe(
      'dev ***, prod ***',
    );
    for (const order of [
      ['s3cret', 's3cret-prod'],
      ['s3cret-prod', 's3cret'],
    ]) {
      expect(registryWith(...order).redact('prod: s3cret-prod, staging: s3cret')).toBe(
        'prod: ***, staging: ***',
      );
    }
    const late = registryWith('first-secret');
    expect(late.redact('uses second-secret')).toBe('uses second-secret');
    late.add('second-secret');
    expect(late.redact('uses second-secret and first-secret')).toBe('uses *** and ***');
    expect(
      registryWith('^(a+|b)*[x]{2}?\\d.$').redact('pw=^(a+|b)*[x]{2}?\\d.$ end, but not aaxx or a1b'),
    ).toBe('pw=*** end, but not aaxx or a1b');
    expect(registryWith('pa.ss').redact('x paXss y pa.ss z')).toBe('x paXss y *** z');

    // Empty, one- and two-character values would garble every line; three characters are masked.
    const text = 'Loaded 3 tables from schema "sales" (a, ab, 12 bytes)';
    expect(registryWith('', 'a', 'ab').redact(text)).toBe(text);
    expect(registryWith('xyz').redact('pw=xyz, not xy')).toBe('pw=***, not xy');

    // A password that was never registered, in a URL or a libpq string.
    const unregistered: [string, string][] = [
      ['postgres://app:hunter2@db:5432/lake', 'postgres://app:***@db:5432/lake'],
      ['postgres://app:p@ssw0rd@db/lake', 'postgres://app:***@db/lake'],
      ['postgres://app:pa:ss@db/lake', 'postgres://app:***@db/lake'],
      ['postgres://:hunter2@db/lake', 'postgres://:***@db/lake'],
      ['postgres://alice@example.com:S3cretPw@db/lake', 'postgres://alice@example.com:***@db/lake'],
      [
        'Cannot reach postgres://app:hunter2@db:5432/lake (timeout)',
        'Cannot reach postgres://app:***@db:5432/lake (timeout)',
      ],
      // The password ends at the last @ of the authority, and the authority ends at a / ? # or a space.
      ['postgres://app:hunter2@db/lake@v2', 'postgres://app:***@db/lake@v2'],
      ['postgres://app:hunter2@db?contact=ops@example.com', 'postgres://app:***@db?contact=ops@example.com'],
      ['postgres://app:hunter2@db#ops@example.com', 'postgres://app:***@db#ops@example.com'],
      [
        'postgres://app:hunter2@db failed, contact ops@example.com',
        'postgres://app:***@db failed, contact ops@example.com',
      ],
      ['host=db Password = hunter2 dbname=lake', 'host=db Password = *** dbname=lake'],
      ['host=db password\t=\ts3cret dbname=lake', 'host=db password\t=\t*** dbname=lake'],
      [
        'host=db sslpassword=k3y PGPASSWORD=s3cret dbname=lake',
        'host=db sslpassword=*** PGPASSWORD=*** dbname=lake',
      ],
      ["host=db password='it\\'s a secret' dbname=lake", 'host=db password=*** dbname=lake'],
      // An unquoted value runs to the next whitespace, whatever it contains: a &, a ; or a , may be part of it.
      [
        "host=db password='s3 cret' application_name='my app' x",
        "host=db password=*** application_name='my app' x",
      ],
      ['host=db password=s3&cr3t dbname=lake', 'host=db password=*** dbname=lake'],
      ['host=db password=s3;cr3t dbname=lake', 'host=db password=*** dbname=lake'],
      [
        'postgresql://db/lake?user=app&password=s3cret&sslmode=require',
        'postgresql://db/lake?user=app&password=***',
      ],
      ["host=db password='abc def dbname=lake", 'host=db password=*** def dbname=lake'],
      [
        'copy postgres://a:one@h1/db to postgres://b:two@h2/db',
        'copy postgres://a:***@h1/db to postgres://b:***@h2/db',
      ],
      ['password=one then password=two', 'password=*** then password=***'],
    ];
    for (const [input, expected] of unregistered) {
      expect(new SecretRegistry().redact(input), input).toBe(expected);
    }

    // Text without a password stays unchanged, also where host:port or an e-mail address looks like one.
    const plain = [
      'Connecting to postgres://db:5432/lake',
      'Connecting to postgres://app@db:5432/lake',
      'Cannot reach postgres://db:5432 (contact ops@example.com)',
      'https://example.com:8443/@alice',
      'https://example.com:8443?contact=me@example.com',
      'https://example.com:8443#me@example.com',
      'proxy://localhost, mail:bob@example.com',
      'https://example.com/users/mail:bob@example.com',
      'https://example.com?q=mail:bob@example.com',
      'https://example.com#mail:bob@example.com',
      'password authentication failed for user "app"',
      'host=db port=5432 user=app dbname=lake',
    ];
    for (const input of plain) {
      expect(registryWith(PASSWORD).redact(input), input).toBe(input);
      expect(new SecretRegistry().redact(input), input).toBe(input);
    }
  });
});

describe('createLogger', () => {
  it('hands every level to the sink with secrets masked in the message, the error, its cause chain and a thrown value', () => {
    const secrets = registryWith(PASSWORD);
    const { log, entries } = loggerWith(secrets);

    log.info('Connected to "prod" (postgres, db:5432)');
    log.warn(`Slow reply for ${PASSWORD}`);
    log.error(`Refresh failed for ${PASSWORD}`);
    log.info('Password not known yet: hunter2-prod');
    secrets.add('hunter2-prod');
    log.info('Password now known: hunter2-prod');
    log.error('Failed', `rejected ${PASSWORD}`);
    log.error('Failed', { user: 'app', password: PASSWORD });
    log.error('Failed', null);
    log.error('Failed', 0);
    log.error('Failed', false);
    log.error('Only the message');

    expect(entries).toEqual([
      ['info', 'Connected to "prod" (postgres, db:5432)'],
      ['warn', 'Slow reply for ***'],
      ['error', 'Refresh failed for ***'],
      ['info', 'Password not known yet: hunter2-prod'],
      ['info', 'Password now known: ***'],
      ['error', 'Failed\nrejected ***'],
      ['error', "Failed\n{ user: 'app', password: '***' }"],
      ['error', 'Failed\nnull'],
      ['error', 'Failed\n0'],
      ['error', 'Failed\nfalse'],
      ['error', 'Only the message'],
    ]);

    const chain = loggerWith(registryWith(PASSWORD));
    const failure = new AantjeError('CONNECTION_FAILED', 'Cannot connect to db:5432.', {
      cause: new Error(`could not connect to postgres://app:${PASSWORD_IN_URL}@db:5432/lake`, {
        cause: new Error(`host=db password=${PASSWORD} dbname=lake`),
      }),
    });
    chain.log.error(`Connecting to "prod" with ${PASSWORD} failed`, failure);
    chain.log.error('Refresh failed', new TypeError(`cannot use ${PASSWORD}`));

    const written = chain.entries.map(([, message]) => message).join('\n');
    expect(written).not.toContain('rd#1');
    expect(written).not.toContain('rd%231');
    expect(withoutFrames(chain.entries[0]?.[1] ?? '').split('\n')).toHaveLength(4);
    expect(chain.entries[1]?.[1]).toMatch(/^Refresh failed\nTypeError: cannot use \*\*\*\n\s+at /);
  });

  it('writes only to its sink: no secret reaches the console or the standard streams', async () => {
    const { log } = loggerWith(registryWith(PASSWORD));
    const printed: unknown[] = [];
    const consoleMethods = (Object.keys(console) as (keyof Console)[]).filter(
      (key) => typeof console[key] === 'function',
    );
    const spies = [
      ...consoleMethods.map((method) =>
        vi.spyOn(console, method as 'log').mockImplementation((...args: unknown[]) => {
          printed.push(...args);
        }),
      ),
      ...[process.stdout, process.stderr].map((stream) =>
        vi.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
          printed.push(chunk);
          return true;
        }),
      ),
    ];

    try {
      log.info(`Connected with ${PASSWORD}`);
      log.warn(`Slow reply for ${PASSWORD}`);
      log.error(`Refresh failed for ${PASSWORD}`, new Error(`rejected ${PASSWORD}`));
      // Output that is deferred must be seen as well.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }

    const text = printed.map((value) => (typeof value === 'string' ? value : inspect(value))).join('\n');
    expect(text).not.toContain(PASSWORD);
  });
});

describe('formatError', () => {
  it('prints the cause chain of any thrown thing: user errors without a stack, bugs with it, causes depth first, cycles once', () => {
    const error = new AantjeError('CONNECTION_FAILED', 'Cannot connect to db:5432.', {
      cause: new Error('connect ECONNREFUSED 10.0.0.5:5432', { cause: new Error('socket closed') }),
    });
    expect(withoutFrames(formatError(error))).toBe(
      [
        'CONNECTION_FAILED: Cannot connect to db:5432.',
        'Caused by: Error: connect ECONNREFUSED 10.0.0.5:5432',
        'Caused by: Error: socket closed',
      ].join('\n'),
    );
    expect(formatError(new AantjeError('ABORTED', 'The query was cancelled.'))).toBe(
      'ABORTED: The query was cancelled.',
    );

    // The stack of any other error is kept, because that is a bug, also when an AantjeError wraps it.
    const lines = formatError(
      new TypeError('x is not a function', { cause: new RangeError('index out of range') }),
    ).split('\n');
    const cause = lines.indexOf('Caused by: RangeError: index out of range');
    expect(lines[0]).toBe('TypeError: x is not a function');
    expect(lines[1]).toMatch(/^\s+at /);
    expect(cause).toBeGreaterThan(1);
    expect(lines[cause + 1]).toMatch(/^\s+at /);

    // Without a stack, name and message remain.
    for (const [bare, expected] of [
      [new TypeError('x is not a function'), 'TypeError: x is not a function'],
      [new RangeError(''), 'RangeError'],
    ] as const) {
      delete bare.stack;
      expect(formatError(bare)).toBe(expected);
      expect(formatError(new AantjeError('ABORTED', 'Cancelled.', { cause: bare }))).toBe(
        `ABORTED: Cancelled.\nCaused by: ${expected}`,
      );
    }

    const aggregate = new AggregateError(
      [
        new Error('first member', { cause: new Error('cause of the first member') }),
        new Error('second member', { cause: new Error('cause of the second member') }),
      ],
      'all failed',
      { cause: new Error('cause of the aggregate') },
    );
    expect(
      withoutFrames(
        formatError(new AantjeError('CONNECTION_FAILED', 'Cannot connect.', { cause: aggregate })),
      ),
    ).toBe(
      [
        'CONNECTION_FAILED: Cannot connect.',
        'Caused by: AggregateError: all failed',
        'Caused by: Error: cause of the aggregate',
        'Caused by: Error: first member',
        'Caused by: Error: cause of the first member',
        'Caused by: Error: second member',
        'Caused by: Error: cause of the second member',
      ].join('\n'),
    );
    const shared = new Error('shared');
    const twice = new AggregateError(
      [new Error('m1', { cause: shared }), new Error('m2', { cause: shared })],
      'agg',
    );
    expect(withoutFrames(formatError(twice))).toBe(
      [
        'AggregateError: agg',
        'Caused by: Error: m1',
        'Caused by: Error: shared',
        'Caused by: Error: m2',
      ].join('\n'),
    );

    // A chain that leads back to itself stops, and an error is not its own cause.
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    first.cause = second;
    expect(
      withoutFrames(formatError(new AantjeError('QUERY_FAILED', 'The query failed.', { cause: first }))),
    ).toBe(
      ['QUERY_FAILED: The query failed.', 'Caused by: Error: first', 'Caused by: Error: second'].join('\n'),
    );
    const self = new AantjeError('QUERY_FAILED', 'The query failed.');
    self.cause = self;
    expect(formatError(self)).toBe('QUERY_FAILED: The query failed.');

    // A value that is not an Error is printed as text, as the cause and as the thrown thing.
    for (const [value, expected] of [
      ['statement timeout', 'statement timeout'],
      [null, 'null'],
      [0, '0'],
    ] as const) {
      expect(formatError(new AantjeError('TIMEOUT', 'Timed out.', { cause: value }))).toBe(
        `TIMEOUT: Timed out.\nCaused by: ${expected}`,
      );
    }
    for (const [value, expected] of [
      ['disk full', 'disk full'],
      [42, '42'],
      [undefined, 'undefined'],
      [10n, '10n'],
      [Symbol('aborted'), 'Symbol(aborted)'],
    ] as const) {
      expect(formatError(value)).toBe(expected);
    }

    // A thrown object shows its fields on one line, also when it is long, has a long array or contains itself.
    expect(formatError({ code: 'E_DISK', detail: 'disk full' })).toContain('disk full');
    const cyclic: Record<string, unknown> = { operation: 'refresh' };
    cyclic.self = cyclic;
    expect(formatError(cyclic)).toContain('operation');
    for (const thrown of [
      {
        code: 'E_DISK',
        detail: 'no space left on device '.repeat(100),
        path: '/var/lib/aantje/catalog.sqlite',
      },
      { code: 'E_DISK', retries: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    ]) {
      const line = formatError(thrown);
      expect(line).toContain('E_DISK');
      expect(line).not.toContain('\n');
    }
  });
});

describe('createOutputChannelLogger', () => {
  it('writes redacted messages to one log channel and releases the channel on dispose', () => {
    const log = createOutputChannelLogger(registryWith(PASSWORD));

    log.info('Connected');
    log.warn(`Slow reply for ${PASSWORD}`);
    log.error('Refresh failed', new AantjeError('TIMEOUT', 'The query timed out.'));
    log.dispose();

    expect(editor.state.opened).toEqual([['aantje', { log: true }]]);
    expect(editor.state.written).toEqual([
      ['info', 'Connected'],
      ['warn', 'Slow reply for ***'],
      ['error', 'Refresh failed\nTIMEOUT: The query timed out.'],
    ]);
    expect(editor.state.disposed).toBe(1);
  });
});

describe('logFailure', () => {
  it('returns the value, and logs a rejection with its error, masked, before it throws the same error again', async () => {
    const entries: [string, string][] = [];
    const secrets = new SecretRegistry();
    secrets.add('hunter2');
    const log = createLogger((level, message) => entries.push([level, message]), secrets);

    await expect(logFailure(log, 'Reading', () => Promise.resolve(42))).resolves.toBe(42);
    expect(entries).toEqual([]);

    const failure = new AantjeError('CONNECTION_FAILED', 'Cannot connect with hunter2.');
    await expect(logFailure(log, 'Testing the connection "a"', () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[0]).toBe('error');
    expect(entries[0]?.[1]).toContain('Testing the connection "a" failed.');
    expect(entries[0]?.[1]).toContain('CONNECTION_FAILED');
    expect(entries[0]?.[1]).not.toContain('hunter2');
  });
});
