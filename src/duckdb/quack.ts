import { quoteLiteral } from '../catalog/ddl';
import type { ErrorCode } from '../errors';

const QUACK_SECRET = 'aantje_quack';

/** The address of a Quack server for DuckDB; the explorer attaches it as is, the data engine behind `ducklake:`. */
export function quackUri(profile: { readonly host: string; readonly port: number }): string {
  return `quack:${profile.host}:${profile.port}`;
}

/** The secret that carries the token of a Quack server; its scope keeps the token away from any other server. */
export function quackSecretStatement(uri: string, token: string): string {
  return `CREATE OR REPLACE TEMPORARY SECRET ${QUACK_SECRET} (TYPE quack, TOKEN ${quoteLiteral(token)}, SCOPE ${quoteLiteral(uri)})`;
}

interface QuackProblem {
  readonly code: ErrorCode;
  /** Lower case, without a full stop: the end of a sentence. */
  readonly reason: string;
  /** The connection to the server is gone; a new instance has to attach it again. */
  readonly reconnect?: boolean;
}

const UNTRUSTED =
  'the server certificate is not trusted: pin its fingerprint with Edit Connection, or give the server a certificate from a CA that this machine trusts';

// The messages of the quack extension of DuckDB 2.0.0, tried in this order.
const QUACK_PROBLEMS: readonly (QuackProblem & { readonly pattern: RegExp })[] = [
  { pattern: /Authentication failed/i, code: 'AUTH_FAILED', reason: 'the server refused the token' },
  {
    pattern: /Could not find a Quack authentication token/,
    code: 'AUTH_FAILED',
    reason: 'no token is stored for this connection, and the server needs one',
  },
  {
    // `Authorization callback failed: <text>` when the server's function raises an error of its own.
    pattern: /Authorization (?:callback )?failed/,
    code: 'QUERY_FAILED',
    reason: 'the server refused the request: its authorization function does not allow it for this token',
  },
  {
    pattern: /Could not connect to server/,
    code: 'CONNECTION_FAILED',
    reason: 'the server does not answer (it is not running, or a firewall blocks the port)',
    reconnect: true,
  },
  {
    pattern: /Could not resolve hostname/,
    code: 'CONNECTION_FAILED',
    reason: 'the host name could not be resolved',
  },
  {
    pattern: /does not match the pinned ssl_fingerprint/,
    code: 'CONNECTION_FAILED',
    reason:
      'the server certificate does not match the pinned fingerprint. If the server has a new certificate, Edit Connection reads and shows it; otherwise something between this machine and the server presents another one',
  },
  {
    pattern: /SSL peer certificate|Problem with the SSL CA cert|Invalid SSL fingerprint/,
    code: 'CONNECTION_FAILED',
    reason: UNTRUSTED,
  },
  {
    pattern: /SSL connect error/,
    code: 'CONNECTION_FAILED',
    reason:
      'the TLS handshake failed: the server may not use TLS on this port (turn off TLS for this connection), or the port is wrong',
  },
  {
    pattern: /Unsupported protocol/,
    code: 'CONNECTION_FAILED',
    reason: 'the server expects TLS: turn on TLS for this connection',
  },
  {
    pattern: /Invalid connection id/,
    code: 'CONNECTION_FAILED',
    reason: 'the server was restarted after the connection was made; connect again',
    reconnect: true,
  },
];

/** What a message of the quack extension means for the user, or undefined for any other message. */
export function quackProblem(message: string): QuackProblem | undefined {
  const found = QUACK_PROBLEMS.find(({ pattern }) => pattern.test(message));
  return found && { code: found.code, reason: found.reason, reconnect: found.reconnect };
}
