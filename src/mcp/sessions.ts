// The SQL sessions of the MCP tools that run a statement: one read-only session per connection, opened on the first
// call, used by one call at a time, closed after ten idle minutes, when the profile changes and when the explorer
// disconnects. Never the session of a SQL editor. Free of the VS Code API.
import type { ConnectionProfile } from '../connections/profile';
import type { SqlSession } from '../sql/session';

/** How long a session may stay unused before it closes. */
export const SESSION_IDLE_MS = 10 * 60 * 1000;

export interface McpSessionsEnv {
  /** Opens a read-only session of the connection; never shows a sign-in. */
  readonly open: (profile: ConnectionProfile, signal: AbortSignal) => Promise<SqlSession>;
  readonly idleMs?: number;
  readonly onError?: (connectionId: string, error: unknown) => void;
}

interface Entry {
  readonly signature: string;
  readonly session: Promise<SqlSession>;
  /** The calls of the connection, one after the other. */
  queue: Promise<unknown>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class McpSessions {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly env: McpSessionsEnv) {}

  /** Runs `work` on the session of the connection once the calls before it have ended. */
  use<T>(
    profile: ConnectionProfile,
    signal: AbortSignal,
    work: (session: SqlSession) => Promise<T>,
  ): Promise<T> {
    const entry = this.entryOf(profile, signal);
    const run = async (): Promise<T> => {
      signal.throwIfAborted();
      if (entry.timer) clearTimeout(entry.timer);
      try {
        return await work(await entry.session);
      } finally {
        this.idle(profile.id, entry);
      }
    };
    const result = entry.queue.then(run, run);
    entry.queue = result.catch(() => undefined);
    return result;
  }

  /** Closes the session of the connection, after the call that uses it. */
  async close(connectionId: string): Promise<void> {
    const entry = this.entries.get(connectionId);
    if (!entry) return;
    this.entries.delete(connectionId);
    if (entry.timer) clearTimeout(entry.timer);
    await entry.queue;
    try {
      await (await entry.session).close();
    } catch (error) {
      // A session that never opened has nothing to close; its call reported the failure.
      this.env.onError?.(connectionId, error);
    }
  }

  /** The connections that have a session now. */
  connections(): string[] {
    return [...this.entries.keys()];
  }

  async dispose(): Promise<void> {
    await Promise.all(this.connections().map((id) => this.close(id)));
  }

  private entryOf(profile: ConnectionProfile, signal: AbortSignal): Entry {
    const signature = JSON.stringify(profile);
    const known = this.entries.get(profile.id);
    if (known?.signature === signature) return known;
    if (known) void this.close(profile.id);
    const session = this.env.open(profile, signal);
    const entry: Entry = { signature, session, queue: Promise.resolve(), timer: undefined };
    // A session that failed to open is not kept: the next call opens a new one.
    session.catch(() => {
      if (this.entries.get(profile.id) === entry) this.entries.delete(profile.id);
    });
    this.entries.set(profile.id, entry);
    return entry;
  }

  private idle(connectionId: string, entry: Entry): void {
    if (this.entries.get(connectionId) !== entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void this.close(connectionId), this.env.idleMs ?? SESSION_IDLE_MS);
    entry.timer.unref?.();
  }
}
