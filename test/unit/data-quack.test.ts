import { afterAll, describe, expect, inject, it } from 'vitest';
import { openQuack } from '../../src/catalog/drivers/quack';
import { createCatalogReader } from '../../src/catalog/reader';
import { certificateFingerprint } from '../../src/connections/fingerprint';
import type { QuackProfile } from '../../src/connections/profile';
import { checkRelation, previewTable } from '../../src/data/engine';
import type { DataAccess } from '../../src/data/types';
import { AantjeError } from '../../src/errors';
import { openSqlSession } from '../../src/sql/session';
import type { QuackFixture } from '../support/quack-fixture';
import { SPEC_VERSION } from '../support/expected';
import { engineSkipReason, extensionDirectory } from './data-support';
import { events, only } from './sql-support';

// The served catalogs are containers of test/support/quack-fixture.ts (only with AANTJE_POSTGRES=1); the Parquet files
// of the data catalog are a copy on this machine, which the client reads itself.
const data = inject('quackData');
const tls = inject('quackTls');
const skipReason =
  data && tls
    ? await engineSkipReason()
    : 'set AANTJE_POSTGRES=1 to run it (needs Docker and the quack extension)';
if (skipReason) {
  console.info(`The data tests on a Quack server are skipped: ${skipReason}.`);
}

const orders = { schema: 'sales', table: 'orders' };
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function profileOf(fixture: QuackFixture, extra: Partial<QuackProfile> = {}): QuackProfile {
  return {
    id: 'served',
    name: 'served',
    kind: 'quack',
    host: fixture.host,
    port: fixture.port,
    ssl: false,
    ...extra,
  };
}

function accessOf(fixture: QuackFixture, profile = profileOf(fixture)): DataAccess {
  return { profile, password: fixture.token, s3: {}, extensionDirectory, viewsTrusted: true };
}

describe.skipIf(skipReason)('the data engine on a Quack server', () => {
  it('previews a table, and a writing SQL session commits while the explorer stays attached and sees the new snapshot', async () => {
    if (!data) throw new Error('unreachable');
    const explorer = createCatalogReader(await openQuack({ ...data, ssl: false, extensionDirectory }));
    cleanups.push(() => explorer.close());
    const before = await explorer.info();

    const preview = await previewTable(accessOf(data), orders);
    expect(preview.rows.map(([id]) => id)).toStrictEqual([1, 3]);

    const session = await openSqlSession({ access: accessOf(data), mode: 'read-write' });
    cleanups.push(() => session.close());
    const run = await events(session, 'CREATE TABLE main.served_answer AS SELECT 42 AS answer');
    expect(only(run, 'error')).toStrictEqual([]);

    const after = await explorer.info();
    expect(after.latestSnapshot).toBe(before.latestSnapshot + 1);
    const main = (await explorer.schemas(after.latestSnapshot)).find(({ name }) => name === 'main');
    const tables = await explorer.tables(main?.id ?? -1, after.latestSnapshot);
    expect(tables.map(({ name }) => name)).toContain('served_answer');
    expect(
      (await previewTable(accessOf(data), { schema: 'main', table: 'served_answer' })).rows,
    ).toStrictEqual([[42]]);

    expect(only(await events(session, 'DROP TABLE main.served_answer'), 'error')).toStrictEqual([]);
  });

  it('trusts a TLS server by the fingerprint that it presents, in the explorer and the engine, and refuses another certificate', async () => {
    if (!tls) throw new Error('unreachable');
    const fingerprint = await certificateFingerprint(tls.host, tls.port);
    const pinned = { ...tls, ssl: true, fingerprint, extensionDirectory };

    const reader = createCatalogReader(await openQuack(pinned));
    cleanups.push(() => reader.close());
    expect((await reader.info()).specVersion).toBe(SPEC_VERSION);
    await checkRelation(accessOf(tls, profileOf(tls, { ssl: true, fingerprint })), orders);

    for (const other of [{ fingerprint: `${'00:'.repeat(31)}00` }, {}]) {
      const error = await openQuack({ ...pinned, ...other, fingerprint: other.fingerprint }).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(AantjeError);
      expect((error as AantjeError).code).toBe('CONNECTION_FAILED');
    }
  }, 90_000);
});
