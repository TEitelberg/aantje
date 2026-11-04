import type { SecretsPort } from '../connections/ports';
import type { S3Credentials } from './types';

const KEY_ID = 'aantje.s3.keyId';
const SECRET_KEY = 'aantje.s3.secretKey';

/**
 * S3 credentials of the data preview in secret storage, else the AWS environment variables; every secret handed out is
 * registered for log redaction.
 */
export class S3CredentialStore {
  constructor(
    private readonly secrets: SecretsPort,
    private readonly registerSecret: (value: string) => void = () => undefined,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  async get(): Promise<S3Credentials | undefined> {
    const stored = await this.stored();
    const credentials = stored ?? this.fromEnvironment();
    if (credentials) {
      this.registerSecret(credentials.keyId);
      this.registerSecret(credentials.secretKey);
    }
    return credentials;
  }

  /** Where `get` finds the credentials; undefined when there are none. */
  async source(): Promise<'stored' | 'environment' | undefined> {
    if (await this.stored()) {
      return 'stored';
    }
    return this.fromEnvironment() ? 'environment' : undefined;
  }

  async set(credentials: S3Credentials): Promise<void> {
    this.registerSecret(credentials.keyId);
    this.registerSecret(credentials.secretKey);
    await this.secrets.set(KEY_ID, credentials.keyId);
    await this.secrets.set(SECRET_KEY, credentials.secretKey);
  }

  async clear(): Promise<void> {
    await this.secrets.delete(KEY_ID);
    await this.secrets.delete(SECRET_KEY);
  }

  private async stored(): Promise<S3Credentials | undefined> {
    const [keyId, secretKey] = await Promise.all([this.secrets.get(KEY_ID), this.secrets.get(SECRET_KEY)]);
    return keyId && secretKey ? { keyId, secretKey } : undefined;
  }

  private fromEnvironment(): S3Credentials | undefined {
    const keyId = this.env.AWS_ACCESS_KEY_ID;
    const secretKey = this.env.AWS_SECRET_ACCESS_KEY;
    return keyId && secretKey ? { keyId, secretKey } : undefined;
  }
}
