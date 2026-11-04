import { AantjeError } from '../errors';
import { isObject } from '../guards';

export interface TokenClaims {
  /** Object ID of the signed-in user in the tenant. */
  readonly oid: string;
  readonly tid: string;
  /** The sign-in name (`upn`, else `preferred_username`); the Entra user name on the PostgreSQL server. Absent for a token without one. */
  readonly userName?: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads `oid`, `tid` and the sign-in name from an access token without checking its signature. The token comes from the sign-in of the
 * user's own editor and the values only fill the role assignment of the user's own deployment; nothing here decides
 * who may do what, Azure does that when it receives the deployment.
 */
export function decodeClaims(token: string): TokenClaims {
  const { oid, tid, upn, preferred_username: preferred } = payloadOf(token);
  if (typeof oid !== 'string' || typeof tid !== 'string' || !GUID.test(oid) || !GUID.test(tid)) {
    throw new AantjeError(
      'INVALID_PROFILE',
      'The Microsoft sign-in did not tell aantje who you are (no object ID).',
    );
  }
  const userName = [upn, preferred].find((name): name is string => typeof name === 'string' && name !== '');
  return { oid, tid, ...(userName === undefined ? {} : { userName }) };
}

/** The sign-in name of the token, or an error that says what is missing; the Entra login of the PostgreSQL server needs it. */
export function requireUserName(token: string): string {
  const { userName } = decodeClaims(token);
  if (userName === undefined) {
    throw new AantjeError(
      'INVALID_PROFILE',
      'The Microsoft sign-in did not tell aantje your user name (no upn), which the Entra login of PostgreSQL needs.',
    );
  }
  return userName;
}

function payloadOf(token: string): Record<string, unknown> {
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    if (isObject(payload)) {
      return payload;
    }
  } catch {
    // Reported below with the other unusable tokens.
  }
  throw new AantjeError('INVALID_PROFILE', 'The Microsoft sign-in returned a token that aantje cannot read.');
}
