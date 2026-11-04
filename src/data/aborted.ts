import { isAantjeError } from '../errors';

/** True when the user declined a confirmation or cancelled an action; nothing went wrong. */
export function isAborted(error: unknown): boolean {
  return isAantjeError(error) && error.code === 'ABORTED';
}
