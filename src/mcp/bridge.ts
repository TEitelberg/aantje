// The stdio bridge that Claude Code starts (dist/mcp-bridge.js, which aantje copies into its global storage at every
// start, so that the path in Claude Code's configuration survives updates). It finds the MCP server of its window
// and forwards each JSON-RPC message from Claude Code (one per line on stdin) to it over HTTP, and each answer back
// (one per line on stdout). Node only: no VS Code API, no third-party code.
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { answeringEntries, pickWindow, processAlive, readWindowEntries, WINDOWS_FOLDER } from './discovery';
import type { WindowEntry } from './discovery';

type Id = string | number;

interface Message {
  readonly id?: Id | null;
  readonly method?: string;
}

const IGNORE_CASE = process.platform === 'win32' || process.platform === 'darwin';
/** How long a window may take to say that its server runs. */
const PROBE_MS = 1500;

let target: WindowEntry | undefined;
let sessionId: string | undefined;
let protocolVersion: string | undefined;

async function windowOf(): Promise<WindowEntry | string> {
  if (target) return target;
  // A file of a process that ended keeps a PID that a new process may have: only a server that answers counts.
  const entries = await answeringEntries(
    await readWindowEntries(join(__dirname, WINDOWS_FOLDER), processAlive),
    PROBE_MS,
  );
  const picked = pickWindow(entries, process.cwd(), IGNORE_CASE);
  if (typeof picked !== 'string') target = picked;
  return picked;
}

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Answers a request with an error, so that Claude Code does not wait; a notification gets nothing. */
function fail(id: Id | null | undefined, text: string): void {
  if (id === undefined || id === null) {
    process.stderr.write(`aantje MCP bridge: ${text}\n`);
    return;
  }
  write({ jsonrpc: '2.0', id, error: { code: -32000, message: text } });
}

/** The JSON-RPC messages of an answer: JSON, or the data lines of an event stream. */
function messagesOf(contentType: string | null, text: string): unknown[] {
  if (text.trim() === '') return [];
  if (contentType?.includes('text/event-stream')) {
    return text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5).trim()) as unknown);
  }
  const value: unknown = JSON.parse(text);
  return Array.isArray(value) ? value : [value];
}

function headersOf(window: WindowEntry): Record<string, string> {
  return {
    Authorization: `Bearer ${window.token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}),
  };
}

async function forward(message: Message): Promise<void> {
  const window = await windowOf();
  if (typeof window === 'string') {
    fail(message.id, window);
    return;
  }
  let response: Response;
  try {
    response = await fetch(window.url, {
      method: 'POST',
      headers: headersOf(window),
      body: JSON.stringify(message),
    });
  } catch (error) {
    // The window may have closed or restarted its server: look for it again next time.
    target = undefined;
    fail(message.id, `aantje's MCP server cannot be reached: ${(error as Error).message}`);
    return;
  }
  const session = response.headers.get('mcp-session-id');
  if (session) sessionId = session;
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 404) target = undefined;
    fail(message.id, `aantje's MCP server answered ${response.status}: ${text.slice(0, 300)}`);
    return;
  }
  for (const reply of messagesOf(response.headers.get('content-type'), text)) {
    const version = (reply as { result?: { protocolVersion?: unknown } }).result?.protocolVersion;
    if (message.method === 'initialize' && typeof version === 'string') protocolVersion = version;
    write(reply);
  }
}

process.stdout.on('error', () => process.exit(0));
const pending = new Set<Promise<void>>();
let initialized: Promise<void> = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (line.trim() === '') return;
  let message: Message;
  try {
    message = JSON.parse(line) as Message;
  } catch {
    fail(undefined, 'a line from the client is no JSON.');
    return;
  }
  // Everything after `initialize` waits for its answer, which brings the session id; then requests run side by side.
  const sent =
    message.method === 'initialize'
      ? (initialized = forward(message))
      : initialized.then(() => forward(message));
  const done = sent
    .catch((error: unknown) => fail(message.id, `the bridge failed: ${(error as Error).message}`))
    .finally(() => pending.delete(done));
  pending.add(done);
});
lines.on('close', () => {
  void Promise.allSettled([...pending]).then(async () => {
    // End the session on the server, so that it does not wait for the idle timeout.
    if (sessionId && target) {
      await fetch(target.url, { method: 'DELETE', headers: headersOf(target) }).catch(() => undefined);
    }
    process.exit(0);
  });
});
