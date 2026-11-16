import { AantjeError, isAantjeError, userMessageOf } from '../errors';
import { isAwsCallError } from './api';

const DENIED =
  /^(AccessDenied|AccessDeniedException|UnauthorizedOperation|UnauthorizedAccess|AuthorizationError)$/;

/** Whether AWS refused the call for a missing permission. */
export function isAccessDenied(error: unknown): boolean {
  return isAwsCallError(error) && (DENIED.test(error.code) || error.status === 403);
}

/** Whether a poll may ask again: no answer, throttling or a server error. */
export function isPassingAwsFailure(error: unknown): boolean {
  return (
    isAwsCallError(error) &&
    (error.code === 'Unreachable' ||
      /Throttl|RequestLimitExceeded|TooManyRequests/.test(error.code) ||
      (error.status !== undefined && error.status >= 500))
  );
}

/** Where the credentials come from, in words. */
export const credentialsName = (awsProfile: string | undefined): string =>
  awsProfile === undefined ? 'the credentials of the environment' : `the AWS profile "${awsProfile}"`;

/** A failure for the user: aantje's own message, or what AWS said with the call that failed. */
export function awsError(error: unknown, awsProfile: string | undefined): unknown {
  if (!isAwsCallError(error)) return error;
  if (error.code === 'Credentials') {
    const login =
      awsProfile === undefined
        ? ''
        : ` For IAM Identity Center run "aws sso login --profile ${awsProfile}" first.`;
    return new AantjeError(
      'AUTH_FAILED',
      `${credentialsName(awsProfile)} gave no valid credentials: ${error.message}${login}`,
      {
        cause: error,
      },
    );
  }
  if (isAccessDenied(error)) {
    return new AantjeError('AUTH_FAILED', `AWS refused ${error.operation}: ${error.message}`, {
      cause: error,
    });
  }
  if (error.code === 'Unreachable') {
    return new AantjeError('CONNECTION_FAILED', `AWS did not answer ${error.operation}: ${error.message}`, {
      cause: error,
    });
  }
  return new AantjeError(
    'CONNECTION_FAILED',
    `AWS refused ${error.operation} (${error.code}): ${error.message}`,
    {
      cause: error,
    },
  );
}

/** The words of a failure, for a message that says more around it. */
export function awsMessageOf(error: unknown, awsProfile: string | undefined): string {
  const mapped = awsError(error, awsProfile);
  return isAantjeError(mapped) ? mapped.userMessage : userMessageOf(mapped);
}
