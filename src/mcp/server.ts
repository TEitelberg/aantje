// The MCP server of aantje: Streamable HTTP on 127.0.0.1, a random port and a token per start. Each client gets a
// session of its own (Mcp-Session-Id), so that a cancel reaches the request it means. Free of the VS Code API:
// src/mcp/mcp.vscode.ts starts it and registers it.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ALIVE_PATH, PID_HEADER } from './discovery';

/** The path of the MCP endpoint. */
export const MCP_PATH = '/mcp';

// The names of this machine in a Host header; with the port, the one of this server.
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** DNS rebinding: a page of another site whose name resolves to 127.0.0.1 still sends its own Host. */
export function isLocalHost(header: string | undefined, port: number): boolean {
  const match = /^(\[[0-9a-f:]+\]|[^:]+)(?::(\d+))?$/i.exec(header ?? '');
  return match !== null && LOCAL_HOSTS.has((match[1] ?? '').toLowerCase()) && Number(match[2] ?? 80) === port;
}
/** The largest request body: a request to aantje's tools is a few kilobytes. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** A session that has not been used for this long is closed. */
const SESSION_IDLE_MS = 60 * 60 * 1000;

export interface McpLog {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export interface McpServerOptions {
  readonly name: string;
  readonly version: string;
  /** What the server tells the assistant with the answer to `initialize`. */
  readonly instructions?: string;
  /** Registers the tools, prompts and resources on the server of a new session. */
  readonly register: (server: McpServer) => void;
  readonly log: McpLog;
}

export interface RunningMcpServer {
  /** `http://127.0.0.1:<port>/mcp`. */
  readonly url: string;
  /** Sent as `Authorization: Bearer <token>`; new at every start. */
  readonly token: string;
  close(): Promise<void>;
}

interface Session {
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
  lastUse: number;
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function refuse(res: ServerResponse, status: number, reason: string): void {
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  res.end(reason);
}

/** The JSON body of a POST, at most MAX_BODY_BYTES. */
async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (declared > MAX_BODY_BYTES) throw new Refusal(413, 'The request is too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Refusal(413, 'The request is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Refusal(400, 'The request is no JSON.');
  }
}

const messagesOf = (body: unknown): readonly unknown[] => (Array.isArray(body) ? body : [body]);

/** A text of the client for the log: at most 80 characters, printable only. */
export const shown = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value.replace(/[^\x20-\x7e]/g, '?').slice(0, 80) : fallback;

/** The client and the protocol version of an `initialize` request, for the log. */
function initializeOf(body: unknown): string | undefined {
  for (const message of messagesOf(body)) {
    if (typeof message !== 'object' || message === null) continue;
    const { method, params } = message as { method?: unknown; params?: Record<string, unknown> };
    if (method !== 'initialize') continue;
    const info = params?.clientInfo as { name?: unknown; version?: unknown } | undefined;
    return `${shown(info?.name, 'a client')} ${shown(info?.version, '')} asks for protocol ${shown(params?.protocolVersion, '?')}`;
  }
  return undefined;
}

const isInitialize = (body: unknown): boolean => initializeOf(body) !== undefined;

/** The JSON-RPC methods of a body, for the log: `tools/call`, `(answer)` for a response. */
const methodsOf = (body: unknown): string =>
  messagesOf(body)
    .map((message) => {
      const method = (message as { method?: unknown } | null)?.method;
      return typeof method === 'string' ? shown(method, '?') : '(answer)';
    })
    .join(', ');

/** Starts the server on 127.0.0.1 and a free port. */
export async function startMcpServer(options: McpServerOptions): Promise<RunningMcpServer> {
  const { log } = options;
  const token = randomBytes(32).toString('base64url');
  const expected = Buffer.from(`Bearer ${token}`);
  const sessions = new Map<string, Session>();

  const authorized = (req: IncomingMessage): boolean => {
    const given = Buffer.from(req.headers.authorization ?? '');
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  async function newSession(): Promise<Session> {
    const server = new McpServer(
      { name: options.name, version: options.version },
      options.instructions === undefined ? {} : { instructions: options.instructions },
    );
    options.register(server);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, session);
      },
    });
    const session: Session = { server, transport, lastUse: Date.now() };
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return session;
  }

  /** The path of a request that passes the checks; a request that does not is refused. */
  function admitted(req: IncomingMessage): string {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (path !== MCP_PATH && path !== ALIVE_PATH) throw new Refusal(404, 'Not found.');
    // Only a Host of this machine; a browser page sends an Origin, no client of aantje does.
    if (!isLocalHost(req.headers.host, port))
      throw new Refusal(403, 'The Host header names another machine.');
    if (req.headers.origin !== undefined) throw new Refusal(403, 'A request from a web page is refused.');
    if (!authorized(req)) throw new Refusal(401, 'The token is missing or wrong.');
    return path;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (admitted(req) === ALIVE_PATH) {
      // The bridge and the other windows ask whether the server of a window file still runs, and in which process.
      res.writeHead(204, { [PID_HEADER]: String(process.pid) });
      res.end();
      return;
    }
    log.debug(
      `MCP: ${req.method ?? '?'} protocol=${String(req.headers['mcp-protocol-version'] ?? '-')} agent=${String(req.headers['user-agent'] ?? '-')}`,
    );
    const id = req.headers['mcp-session-id'];
    const known = typeof id === 'string' ? sessions.get(id) : undefined;
    // An unknown session id is 404, so that the client starts a new session; no id outside `initialize` is 400.
    if (typeof id === 'string' && !known) {
      throw new Refusal(404, 'The session is unknown or has ended; start a new one.');
    }
    if (req.method === 'POST') {
      const body = await bodyOf(req);
      log.debug(`MCP: methods ${methodsOf(body)}${known ? '' : ' (no session)'}`);
      const session = known ?? (isInitialize(body) ? await newSession() : undefined);
      if (!session) {
        // Clients of the stateless revision 2026-07-28 probe `server/discover` first, then fall back to `initialize`.
        noSession(res, body);
        return;
      }
      const asked = initializeOf(body);
      if (asked) log.info(`MCP: ${asked}.`);
      session.lastUse = Date.now();
      await session.transport.handleRequest(req, res, body);
      return;
    }
    if (!known) throw new Refusal(400, 'A session id is required.');
    known.lastUse = Date.now();
    await known.transport.handleRequest(req, res);
  }

  // A request without a session that is no `initialize`: a JSON-RPC error with 400, as the transport of the SDK does.
  function noSession(res: ServerResponse, body: unknown): void {
    const [first] = messagesOf(body) as { id?: unknown; method?: unknown }[];
    log.debug(`MCP: ${shown(first?.method, 'a request')} without a session is answered with 400.`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: typeof first?.id === 'string' || typeof first?.id === 'number' ? first.id : null,
        error: {
          code: -32000,
          message: 'Bad Request: start a session with initialize (protocol 2025-11-25).',
        },
      }),
    );
  }

  let port = 0;
  const http = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof Refusal) {
        log.warn(`MCP: refused a request (${error.status}): ${error.message}`);
        refuse(res, error.status, error.message);
      } else {
        log.warn(`MCP: a request failed: ${error instanceof Error ? error.message : String(error)}`);
        refuse(res, 500, 'The request failed.');
      }
    });
  });
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastUse > SESSION_IDLE_MS) {
        sessions.delete(id);
        void session.transport.close();
        void session.server.close();
      }
    }
  }, 60_000);
  sweep.unref();

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => resolve());
  });
  ({ port } = http.address() as AddressInfo);
  return {
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    token,
    async close() {
      clearInterval(sweep);
      await Promise.all(
        [...sessions.values()].map(async ({ server, transport }) => {
          await transport.close();
          await server.close();
        }),
      );
      sessions.clear();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
