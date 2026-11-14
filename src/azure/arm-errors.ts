import { AantjeError } from '../errors';
import { isObject } from '../guards';

export interface ArmError {
  readonly code: string;
  readonly message: string;
}

/** The `error` of an ARM response body or of a failed deployment operation; undefined for any other shape. */
export function armErrorOf(body: unknown): ArmError | undefined {
  return isObject(body) && isObject(body.error) ? errorOf(body.error) : undefined;
}

function errorOf(error: Record<string, unknown>): ArmError {
  const details = Array.isArray(error.details) ? (error.details as unknown[]) : [];
  // A deployment error wraps the failures of its resources one level down; they say what went wrong.
  const inner = details.find(isObject);
  if (inner && /^(DeploymentFailed|ResourceDeploymentFailure)$/.test(String(error.code))) {
    return errorOf(inner);
  }
  return plainError(error);
}

const plainError = (error: Record<string, unknown>): ArmError => ({
  code: typeof error.code === 'string' ? error.code : 'Unknown',
  message: typeof error.message === 'string' ? error.message : '',
});

const detailsOf = (error: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(error.details) ? error.details.filter(isObject) : [];

const DENIED = /^(Linked)?AuthorizationFailed$/;
// The check before a deployment can name a refused permission only in its text, under `InvalidTemplateDeployment`.
const DENIED_TEXT =
  /Authorization failed for template resource|does not have (authorization|permission) to perform action/i;

/**
 * Whether the `error` of an ARM answer, or an error among its details at any depth, says that Azure refused the
 * caller a permission: the code `AuthorizationFailed` or `LinkedAuthorizationFailed`, or the text of such a refusal.
 */
export function deniesPermission(error: unknown): boolean {
  return (
    isObject(error) &&
    (DENIED.test(String(error.code)) ||
      DENIED_TEXT.test(String(error.message)) ||
      detailsOf(error).some(deniesPermission))
  );
}

/** The errors at the ends of the details of an ARM error: the reasons, below the errors that only wrap them. */
function reasonsOf(error: unknown): ArmError[] {
  if (!isObject(error)) {
    return [];
  }
  const below = detailsOf(error).flatMap(reasonsOf);
  return below.length > 0 ? below : [plainError(error)];
}

/** What Azure said in an ARM error, as `code: message` for each of its reasons. */
export function armReasons(error: unknown): string {
  return reasonsOf(error)
    .map(({ code, message }) => `${code}: ${message}`.replace(/\s+/g, ' ').trim())
    .join(' ');
}

const RULES: readonly { readonly match: RegExp; readonly text: string }[] = [
  {
    match: /Standard_ZRS|ZRS|zone.redundant/i,
    text: 'The region does not offer zone-redundant storage (ZRS) for this account. Choose Small or another region.',
  },
  {
    match:
      /SkuNotAvailable|LocationNotAvailableForResourceType|not available in location|NotSupportedForRegion|RegionIsOfferRestricted/i,
    text: 'The region does not offer this size for your subscription. Choose another region or size.',
  },
  {
    match: /AuthorizationFailed|does not have authorization|RoleAssignmentUpdateNotPermitted/i,
    text: 'Your account is not allowed to do this. Creating the role assignment needs Owner or User Access Administrator on the resource group.',
  },
  {
    match: /StorageAccountAlreadyTaken|AccountNameInvalid|already taken/i,
    text: 'The storage account name is taken or invalid. Choose another name.',
  },
  {
    match: /MissingSubscriptionRegistration|NoRegisteredProviderFound/i,
    text: 'The subscription has not registered a resource provider that the deployment needs (Microsoft.DBforPostgreSQL, Microsoft.Storage). Register it in the Azure portal under Resource providers.',
  },
  {
    match: /QuotaExceeded|OperationNotAllowed.*quota/i,
    text: 'The subscription has no quota left for this size in the region. Choose another region or size, or ask for more quota.',
  },
  {
    match: /PrincipalNotFound/i,
    text: 'Azure does not know your account yet for the role assignment. Wait a minute and run the command again.',
  },
  {
    match: /ParameterOutOfRange.*Version/i,
    text: 'The region offers no PostgreSQL version to this subscription (an offer restriction, or the region is not open for it). Choose another region.',
  },
  {
    match: /InvalidParameter|PasswordTooWeak|InvalidAdministratorLogin/i,
    text: 'Azure refused a setting of the deployment.',
  },
];

/** A message for the user: the known causes in plain words, always followed by what Azure said. */
function describeArmError(error: ArmError, status?: number): string {
  const said = `${error.code}: ${error.message}`.replace(/\s+/g, ' ').trim();
  const rule = RULES.find(({ match }) => match.test(said));
  const hint =
    rule?.text ?? (status === 401 ? 'The Microsoft sign-in is not valid any more. Sign in again.' : '');
  return hint ? `${hint} Azure said: ${said}` : `Azure said: ${said}`;
}

/** The error the commands show; Azure messages carry no secrets, the password is never sent in a request that echoes it. */
export function armFailure(error: ArmError, status?: number): AantjeError {
  return new AantjeError(
    status === 401 ? 'AUTH_FAILED' : 'CONNECTION_FAILED',
    describeArmError(error, status),
  );
}

/**
 * The error of a deployment that Azure's check before the start refused. Azure wraps the reasons
 * (`InvalidTemplateDeployment`, `PreflightValidationCheckFailed`); each reason is shown with the hint of a known cause.
 */
export function validationFailure(error: unknown, status: number): AantjeError {
  return new AantjeError(
    status === 401 ? 'AUTH_FAILED' : 'CONNECTION_FAILED',
    [
      "Azure's check of the deployment refused it.",
      ...reasonsOf(error).map((reason) => describeArmError(reason, status)),
    ].join(' '),
  );
}
