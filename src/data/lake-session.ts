import type * as Duckdb from '@duckdb/node-api';
import { interruptRepeatedly, loadEngine, MAX_TIMEOUT_MS } from '../duckdb/engine';
import { firstLine, scrubbed } from '../duckdb/messages';
import { userMessageOf } from '../errors';
import { setupStatements } from './attach';
import { secretsOf } from './errors';
import type { Phase } from './errors';
import { toGridValue } from './grid-values';
import { withOpenLake } from './open-lake';
import type { DataAccess, GridValue } from './types';

/**
 * A failed health check statement: `text` is the whole engine message without secrets, `timedOut` marks the statement
 * limit.
 */
export class LakeFailure extends Error {
  constructor(
    readonly phase: Phase,
    readonly text: string,
    readonly timedOut = false,
  ) {
    super(firstLine(text));
    this.name = 'LakeFailure';
  }
}

/** A failure message safe to show: the first line of a failed statement, an `AantjeError` text, else a generic one. */
export function failureMessageOf(error: unknown): string {
  return error instanceof LakeFailure ? error.message : userMessageOf(error);
}

function lakeFailure(cause: unknown, phase: Phase, access: DataAccess): LakeFailure {
  // DuckDB echoes the statement ("LINE 1: ..."), which adds nothing.
  const text = scrubbed(cause, secretsOf(access)).text.replace(/\r?\n\r?\nLINE \d+:[\s\S]*$/, '');
  return new LakeFailure(phase, text);
}

/** Read-only statements of the health check on one attached lake. */
export interface LakeSession {
  /** Runs one statement and returns JSON rows; failures are `LakeFailure`, `limitMs` ends a slower statement. */
  rows(sql: string, limitMs?: number): Promise<readonly (readonly GridValue[])[]>;
}

/**
 * Runs `use` on a session with the lake at its newest snapshot. The caller limits each statement; `access.timeoutMs`
 * limits the attach only, so that a server that accepts the connection and never answers ends the setup. A failed
 * setup is a `LakeFailure` with its `phase`; `use` should catch its statements' failures. A statement that exceeded its
 * limit is still interrupted and waited for (up to `INTERRUPT_GRACE_MS`) before the engine closes, because closing a
 * connection with a running statement blocks the thread.
 */
export async function withLakeSession<T>(
  access: DataAccess,
  signal: AbortSignal | undefined,
  use: (session: LakeSession) => Promise<T>,
): Promise<T> {
  const newest = { ...access, snapshot: undefined };
  return withOpenLake({
    engine: await loadEngine(),
    access: newest,
    signal,
    setup: setupStatements(newest),
    limitSetupOnly: true,
    cancelledText: 'Reading the lake was cancelled.',
    activity: 'Reading the lake',
    use: async ({ connection }) => {
      const { session, settle } = sessionOf(connection, access);
      try {
        return await use(session);
      } finally {
        await settle();
      }
    },
    fail: (cause, phase) =>
      Promise.resolve(cause instanceof LakeFailure ? cause : lakeFailure(cause, phase, access)),
  });
}

// How long the session waits for an interrupted statement: before the next statement and before the close.
const INTERRUPT_GRACE_MS = 3000;

function sessionOf(
  connection: Duckdb.DuckDBConnection,
  access: DataAccess,
): { session: LakeSession; settle: () => Promise<void> } {
  // After a timeout the statement may still run (a blocked network read cannot be interrupted); the next one waits.
  let pending: Promise<void> | undefined;
  let stopInterrupt: (() => void) | undefined;
  // Whether the interrupted statement ended within the grace.
  const settled = async (): Promise<boolean> => {
    if (pending === undefined) return true;
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([
      pending,
      new Promise((resolve) => {
        grace = setTimeout(resolve, INTERRUPT_GRACE_MS);
      }),
    ]);
    clearTimeout(grace);
    return pending === undefined;
  };
  const session: LakeSession = {
    async rows(sql, limitMs) {
      if (!(await settled())) {
        throw new LakeFailure(
          'query',
          'The engine is still busy with a statement that exceeded its time limit.',
          true,
        );
      }
      const running = connection
        .runAndReadAll(sql)
        .then((reader) => reader.getRowsJson().map((row) => row.map(toGridValue)));
      let timer: NodeJS.Timeout | undefined;
      let expired = false;
      try {
        if (limitMs === undefined) return await running;
        const limit = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              expired = true;
              reject(
                new LakeFailure(
                  'query',
                  `The statement exceeded its time limit of ${limitMs / 1000} s and was cancelled.`,
                  true,
                ),
              );
            },
            Math.min(limitMs, MAX_TIMEOUT_MS),
          );
        });
        return await Promise.race([running, limit]);
      } catch (cause) {
        throw cause instanceof LakeFailure ? cause : lakeFailure(cause, 'query', access);
      } finally {
        clearTimeout(timer);
        if (expired) {
          stopInterrupt = interruptRepeatedly(connection);
          pending = running
            .catch(() => undefined)
            .then(() => {
              stopInterrupt?.();
              stopInterrupt = undefined;
              pending = undefined;
            });
        }
      }
    },
  };
  return {
    session,
    // Before the close: the interval must not poke a closed handle, whether the statement ended or was given up on.
    async settle() {
      if (!(await settled())) {
        stopInterrupt?.();
        stopInterrupt = undefined;
        access.log?.warn(
          `A statement that exceeded its time limit did not end within ${INTERRUPT_GRACE_MS / 1000} s of being interrupted; the engine is closed anyway.`,
        );
      }
    },
  };
}
