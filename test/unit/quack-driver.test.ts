import { DuckDBInstance } from '@duckdb/node-api';
import { describe, expect, it } from 'vitest';
import { inlineParameters, openQuack, quackSetup } from '../../src/catalog/drivers/quack';
import { AantjeError, messageOf } from '../../src/errors';
import { engineSkipReason, extensionDirectory } from './data-support';

// The served catalog itself is read in the contract suites (test/support/sources/quack.ts, Docker).

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`The Quack driver tests on the engine are skipped: ${skipReason}`);
}

async function refusal(promise: Promise<unknown>): Promise<AantjeError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(AantjeError);
  return error as AantjeError;
}

describe('the statements of the Quack driver', () => {
  it('puts the token only into the scoped secret, before the attach, and locks the instance to the one server last', () => {
    const setup = quackSetup({
      host: 'duckdb',
      port: 9494,
      token: "tok'en-1",
      ssl: true,
      fingerprint: 'AB:CD',
    });

    expect(setup.filter((sql) => sql.includes('en-1'))).toStrictEqual([
      "CREATE OR REPLACE TEMPORARY SECRET aantje_quack (TYPE quack, TOKEN 'tok''en-1', SCOPE 'quack:duckdb:9494')",
    ]);
    expect(setup.findIndex((sql) => sql.includes('SECRET'))).toBeLessThan(
      setup.findIndex((sql) => sql.startsWith('ATTACH')),
    );
    expect(setup).toContain(
      "ATTACH 'quack:duckdb:9494' AS metadata (DISABLE_SSL false, SSL_FINGERPRINT 'AB:CD')",
    );
    expect(setup).toContain("SET allowed_paths = ['https://duckdb:9494/quack']");
    expect(setup.at(-1)).toBe('SET lock_configuration = true');

    const plain = quackSetup({ host: '127.0.0.1', port: 1, ssl: false });
    expect(plain.some((sql) => sql.includes('SECRET'))).toBe(false);
    expect(plain).toContain("SET allowed_paths = ['http://127.0.0.1:1/quack']");
  });

  it.skipIf(skipReason)(
    'writes each value as a literal that the engine reads back as the same value, also a negative number after a minus',
    async () => {
      const params = [13, -3, 0.5, "O'Brien", 'a?b', null, true, false];
      const sql = inlineParameters('SELECT ?, 1 -?, ?, ?, ?, ?, ?, ?', params);
      const instance = await DuckDBInstance.create(':memory:');
      const connection = await instance.connect();
      try {
        const [row] = (await connection.runAndReadAll(sql)).getRowsJson();
        expect(row).toStrictEqual([13, 4, '0.5', "O'Brien", 'a?b', null, true, false]);
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
    },
  );

  it('refuses a statement whose placeholders do not match the values, and a number SQL cannot write', () => {
    expect(() => inlineParameters('SELECT ?', [])).toThrow(AantjeError);
    expect(() => inlineParameters('SELECT 1', [1])).toThrow(AantjeError);
    expect(() => inlineParameters('SELECT ?', [Number.NaN])).toThrow(AantjeError);
  });
});

describe.skipIf(skipReason)('opening a Quack catalog that cannot be reached', () => {
  it('reports a missing token as AUTH_FAILED before it sends anything, so that the connect flow asks for it', async () => {
    const error = await refusal(openQuack({ host: '127.0.0.1', port: 1, ssl: false, extensionDirectory }));
    expect(error.code).toBe('AUTH_FAILED');
  });

  it('keeps the token out of the message and the cause, also where the engine repeats it', async () => {
    const token = 'tok-canary-5f1e';
    const error = await refusal(
      openQuack({ host: `${token}.invalid`, port: 9494, token, ssl: false, extensionDirectory }),
    );
    expect(error.code).toBe('CONNECTION_FAILED');
    expect(error.userMessage).toContain('could not be resolved');
    expect(`${error.userMessage} ${messageOf(error.cause)}`).not.toContain(token);
  });
});
