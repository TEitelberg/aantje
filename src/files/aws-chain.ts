import { loadEngine } from '../duckdb/engine';
import { scrubbed } from '../duckdb/messages';
import { AantjeError } from '../errors';
import type { ResolvedStorage } from '../storage/config';
import { storageExtensions, storageSecretName, storageSecretStatement } from '../storage/statements';
import type { S3Keys } from './sigv4';

// The keys of an AWS credential chain (SSO, a profile, the environment, ...). aantje does not resolve the chain
// itself: the engine does, with the same secret statement that the lake is read with. A private, short-lived engine
// creates the secret and hands back what the chain resolved; the Files folder signs its listing with it.

/** The keys and the region in the text of a secret (`duckdb_secrets()`, unredacted); undefined without both keys. */
export function keysOfSecret(text: string): { keys: S3Keys; region?: string } | undefined {
  const fields = new Map<string, string>();
  for (const part of text.split(';')) {
    const at = part.indexOf('=');
    if (at > 0) fields.set(part.slice(0, at), part.slice(at + 1));
  }
  const keyId = fields.get('key_id');
  const secretKey = fields.get('secret');
  const token = fields.get('session_token');
  const region = fields.get('region');
  if (!keyId || !secretKey || secretKey === 'redacted') return undefined;
  return {
    keys: { keyId, secretKey, ...(token && token !== 'redacted' ? { sessionToken: token } : {}) },
    ...(region ? { region } : {}),
  };
}

/**
 * Lets the engine resolve the credential chain of the storage and returns the keys; undefined when the chain gave
 * none (a public bucket is then listed unsigned). `register` receives every value for the masking of the log.
 */
export async function resolveChainKeys(
  storage: ResolvedStorage,
  extensionDirectory: string | undefined,
  register: (value: string) => void,
): Promise<{ keys: S3Keys; region?: string } | undefined> {
  const statement = storageSecretStatement(storage);
  if (statement === undefined) return undefined;
  const engine = await loadEngine('; the Files folder needs it to resolve the AWS credential chain.');
  const instance = await engine.DuckDBInstance.create(':memory:', {
    allow_persistent_secrets: 'false',
    allow_unredacted_secrets: 'true',
    ...(extensionDirectory ? { extension_directory: extensionDirectory } : {}),
  });
  const connection = await instance.connect();
  try {
    for (const sql of [...storageExtensions(storage), statement]) {
      await connection.run(sql);
    }
    const reader = await connection.runAndReadAll(
      `SELECT secret_string FROM duckdb_secrets(redact := false) WHERE name = '${storageSecretName(storage)}'`,
    );
    const text = reader.getRowsJson()[0]?.[0];
    const found = typeof text === 'string' ? keysOfSecret(text) : undefined;
    for (const value of Object.values(found?.keys ?? {}) as string[]) register(value);
    return found;
  } catch (cause) {
    throw new AantjeError(
      'AUTH_FAILED',
      `The AWS credential chain gave no keys: ${scrubbed(cause, []).line}`,
      { cause },
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
