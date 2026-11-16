// How every tool of aantje's MCP server answers and is logged. Free of the VS Code API.
import * as z from 'zod';
import { isAantjeError, isAborted } from '../errors';
import type { Logger } from '../log';
import { ToolError } from './catalog';
import { shown } from './server';

export interface AnswerEnv {
  /** Masks the secrets aantje knows in a text that goes to the client. */
  readonly redact: (text: string) => string;
  readonly log: Pick<Logger, 'info' | 'error'>;
}

export const CONNECTION = z
  .string()
  .describe(
    'The name of a connection, as list_connections returns it. It must be connected in the explorer.',
  );
export const SCHEMA = z.string().describe('The name of a schema of the lake.');

// The statement in a log line: one line, at most 200 characters.
const statementLine = (sql: string): string => {
  const line = sql.replace(/\s+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};

/** What the client is told of a failure: aantje's own message, never the text of an unexpected error. */
function clientMessage(error: unknown): string {
  if (error instanceof ToolError) return error.message;
  if (isAborted(error)) return 'The call was cancelled.';
  if (isAantjeError(error)) return error.userMessage;
  return 'Reading the catalog failed. The output channel of aantje has the details.';
}

/**
 * Runs a tool and logs the call: the tool, the connection, the statement, the duration, and the size of the result or
 * the error. The result goes out structured and as the same JSON text, for clients that read only text.
 */
export async function answer<T extends Record<string, unknown>>(
  env: AnswerEnv,
  call: { readonly tool: string; readonly connection?: string; readonly statement?: string },
  read: () => T | Promise<T>,
) {
  const started = performance.now();
  const on = call.connection === undefined ? '' : ` on "${shown(call.connection, '?')}"`;
  const what = call.statement === undefined ? '' : ` [${env.redact(statementLine(call.statement))}]`;
  const line = `MCP: ${call.tool}${on}${what}`;
  const took = (): string => `${Math.round(performance.now() - started)} ms`;
  try {
    const structuredContent = await read();
    const text = JSON.stringify(structuredContent);
    env.log.info(`${line}: ${text.length} characters (${took()}).`);
    return { content: [{ type: 'text' as const, text }], structuredContent };
  } catch (error) {
    const message = env.redact(clientMessage(error));
    if (error instanceof ToolError || isAborted(error) || isAantjeError(error)) {
      env.log.info(`${line} failed (${took()}): ${message}`);
    } else {
      env.log.error(`${line} failed (${took()}).`, error);
    }
    return { content: [{ type: 'text' as const, text: message }], isError: true };
  }
}
