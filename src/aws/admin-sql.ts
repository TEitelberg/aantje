// Statements that the administrator of an AWS lake runs once, over TLS checked against the certificate authorities of
// RDS: the explorer's connections are read-only, so this has a client of its own.
import { readFileSync } from 'node:fs';
import { rdsCaPathFor } from '../connections/rds-ca';
import { AantjeError, messageOf } from '../errors';
import type { AdminConnection } from './iam-role';

export async function runAsAdmin(connection: AdminConnection, statements: readonly string[]): Promise<void> {
  // Imported on demand, as the PostgreSQL driver of the explorer is.
  const { Client } = await import('pg');
  const ca = rdsCaPathFor(connection.host);
  const client = new Client({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password,
    ssl: { rejectUnauthorized: true, ...(ca === undefined ? {} : { ca: readFileSync(ca, 'utf8') }) },
    application_name: 'aantje',
    connectionTimeoutMillis: 15_000,
    statement_timeout: 60_000,
  });
  try {
    await client.connect();
    for (const sql of statements) await client.query(sql);
  } catch (cause) {
    throw new AantjeError(
      'CONNECTION_FAILED',
      `PostgreSQL refused a statement of the administrator ${connection.user}: ${messageOf(cause)}`,
      { cause },
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
