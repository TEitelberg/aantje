import type { SecretsPort, SettingsPort } from '../connections/ports';
import { parseTargets, toSettingEntry, usesSecret } from './target';
import type { IcebergTarget } from './target';

const secretKey = (id: string): string => `aantje.iceberg.${id}.secret`;

/** What a stored secret belongs to: another endpoint or client must never receive it. */
const bindingOf = (target: Pick<IcebergTarget, 'endpoint' | 'clientId'>): string =>
  `${target.endpoint}\n${target.clientId ?? ''}`;

/** The targets in `aantje.icebergTargets` and their secrets in the secret storage; a write touches only its own entry. */
export class IcebergTargetStore {
  constructor(
    private readonly settings: SettingsPort,
    private readonly secrets: SecretsPort,
    /** Called with every secret read or written, so the log redactor knows it. */
    private readonly registerSecret: (value: string) => void = () => undefined,
  ) {}

  list(): IcebergTarget[] {
    return parseTargets(this.settings.read()).targets;
  }

  get(id: string): IcebergTarget | undefined {
    return this.list().find((target) => target.id === id);
  }

  problems(): string[] {
    return parseTargets(this.settings.read()).problems;
  }

  /** The secret, but only when it was stored for this endpoint and client. */
  async secret(target: IcebergTarget): Promise<string | undefined> {
    if (!usesSecret(target)) return undefined;
    const raw = await this.secrets.get(secretKey(target.id));
    if (raw === undefined) return undefined;
    try {
      const stored = JSON.parse(raw) as { binding?: unknown; value?: unknown };
      if (stored.binding !== bindingOf(target) || typeof stored.value !== 'string') return undefined;
      this.registerSecret(stored.value);
      return stored.value;
    } catch {
      return undefined;
    }
  }

  async setSecret(target: IcebergTarget, value: string): Promise<void> {
    this.registerSecret(value);
    await this.secrets.set(secretKey(target.id), JSON.stringify({ binding: bindingOf(target), value }));
  }

  /** Appends the target; the secret, if any, goes to the secret storage and never to the setting. */
  async add(target: IcebergTarget, secret?: string): Promise<void> {
    const raw = this.settings.read();
    const entries: unknown[] = Array.isArray(raw) ? raw : [];
    if (secret) await this.setSecret(target, secret);
    else await this.secrets.delete(secretKey(target.id));
    await this.settings.write([...entries, toSettingEntry(target)]);
  }

  /** Removes the entry and its secret; entries that do not parse stay as they are. */
  async remove(id: string): Promise<void> {
    const raw = this.settings.read();
    const entries: unknown[] = Array.isArray(raw) ? raw : [];
    const kept = entries.filter(
      (entry) =>
        !(typeof entry === 'object' && entry !== null && (entry as { id?: unknown }).id === id) &&
        !(parseTargets([entry]).targets[0]?.id === id),
    );
    await this.settings.write(kept);
    await this.secrets.delete(secretKey(id));
  }
}
