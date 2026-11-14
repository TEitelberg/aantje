import type { ConnectionProfile } from '../connections/profile';

/** The list of trusted keys in a persistent store (VS Code `Memento`, a file in tests). */
export interface MementoPort {
  get(): readonly string[];
  update(value: readonly string[]): Promise<void>;
}

/**
 * Remembers which connections the user trusts to bind views (catalog SQL run with external access). Trust is tied to
 * the target: editing host, port, database, user, schema, TLS, the pinned certificate or the path asks again.
 */
export class ViewTrustStore {
  private readonly listeners = new Set<(profile: ConnectionProfile) => void>();

  constructor(private readonly port: MementoPort) {}

  isTrusted(profile: ConnectionProfile): boolean {
    return this.port.get().includes(trustKey(profile));
  }

  async trust(profile: ConnectionProfile): Promise<void> {
    if (!this.isTrusted(profile)) {
      await this.port.update([...this.port.get(), trustKey(profile)]);
      for (const listener of [...this.listeners]) {
        listener(profile);
      }
    }
  }

  /** Calls the listener after a connection is newly trusted, so earlier refused views can be resolved. */
  onDidTrust(listener: (profile: ConnectionProfile) => void): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** Forgets the connection's trust, whatever target it had when granted. */
  async revoke(profile: ConnectionProfile): Promise<void> {
    const prefix = `${idPart(profile)} `;
    const keys = this.port.get();
    const remaining = keys.filter((key) => !key.startsWith(prefix));
    if (remaining.length !== keys.length) {
      await this.port.update(remaining);
    }
  }

  async revokeAll(): Promise<void> {
    await this.port.update([]);
  }
}

/** Where a connection points to, as shown to the user: `host:port/database`, `host:port` (Quack) or the file path. */
export function targetOf(profile: ConnectionProfile): string {
  switch (profile.kind) {
    case 'postgres':
      return `${profile.host}:${profile.port}/${profile.database}`;
    case 'quack':
      return `${profile.host}:${profile.port}`;
    default:
      return profile.path;
  }
}

// The encoded id has no space, so the prefix tells one connection's keys from another's.
function idPart(profile: ConnectionProfile): string {
  return encodeURIComponent(profile.id);
}

/** Identifies a connection with its target; profiles with the same key share one trust. */
export function trustKey(profile: ConnectionProfile): string {
  const target =
    profile.kind === 'postgres'
      ? [
          profile.kind,
          profile.host,
          profile.port,
          profile.database,
          profile.user,
          profile.metadataSchema ?? null,
          profile.ssl ?? false,
        ]
      : profile.kind === 'quack'
        ? // A pin counts only with TLS, as for the attach.
          [
            profile.kind,
            profile.host,
            profile.port,
            profile.ssl,
            profile.ssl ? (profile.fingerprint ?? null) : null,
          ]
        : [profile.kind, profile.path];
  return `${idPart(profile)} ${JSON.stringify(target)}`;
}
