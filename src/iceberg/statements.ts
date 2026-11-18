import { quoteLiteral } from '../catalog/ddl';
import { ONELAKE_HOST } from '../storage/config';
import { azureExtensions } from '../storage/statements';
import { oauth2ServerUriOf } from './target';
import type { IcebergTarget } from './target';

/** Name under which the Iceberg catalog is attached. */
export const ICEBERG = 'ice';
const SECRET = 'aantje_iceberg';
/** The OneLake secret of a Fabric target; its own name, so that it never replaces the secret of a lake on OneLake. */
const FABRIC_STORAGE_SECRET = 'aantje_iceberg_onelake';

/**
 * SQL that attaches the catalog of a target: the extensions (loaded before the configuration lock) and the secret and
 * ATTACH (after the lake is attached). The secret appears only in `CREATE SECRET`.
 *
 * A Fabric lakehouse takes the token of the Microsoft account twice: for the Iceberg catalog of OneLake and for OneLake
 * itself, where the data files go. DuckDB 2.0 cannot write with the credentials that OneLake vends (checked
 * 2026-11-16), so aantje writes with its own OneLake secret, limited to the workspace of the lakehouse. OneLake commits
 * one table at a time and creates a table at once.
 */
export function icebergSetup(
  target: IcebergTarget,
  secret: string | undefined,
  platform: NodeJS.Platform = process.platform,
): { readonly extensions: string[]; readonly attach: string[] } {
  const extensions = ['INSTALL httpfs', 'LOAD httpfs', 'INSTALL iceberg', 'LOAD iceberg'];
  if (target.fabric) {
    return {
      extensions: [...extensions, ...azureExtensions(platform)],
      attach: [...fabricSecrets(target, secret), attachStatement(target)],
    };
  }
  const attach: string[] = [];
  if (target.signIn === 'oauth2') {
    const scope = target.scope === undefined ? '' : `, OAUTH2_SCOPE ${quoteLiteral(target.scope)}`;
    attach.push(
      `CREATE OR REPLACE SECRET ${SECRET} (TYPE iceberg, CLIENT_ID ${quoteLiteral(target.clientId ?? '')}, CLIENT_SECRET ${quoteLiteral(secret ?? '')}, OAUTH2_SERVER_URI ${quoteLiteral(oauth2ServerUriOf(target))}${scope})`,
    );
  } else if (target.signIn === 'token') {
    attach.push(`CREATE OR REPLACE SECRET ${SECRET} (TYPE iceberg, TOKEN ${quoteLiteral(secret ?? '')})`);
  }
  attach.push(attachStatement(target));
  return { extensions, attach };
}

/**
 * The statements that put a new token of the Microsoft account into the engine of a sync to a Fabric lakehouse. OneLake
 * reads a replaced secret at once; the attached catalog keeps the token it was attached with, so it is attached again
 * (checked 2026-11-16). Undefined for any other target: their sign-in does not run out during a sync.
 */
export function icebergRenewal(target: IcebergTarget, token: string): string[] | undefined {
  if (!target.fabric) return undefined;
  return [...fabricSecrets(target, token), `DETACH DATABASE IF EXISTS ${ICEBERG}`, attachStatement(target)];
}

function fabricSecrets(target: IcebergTarget, token: string | undefined): string[] {
  const value = quoteLiteral(token ?? '');
  const scope = `abfss://${target.fabric?.workspace ?? ''}@${ONELAKE_HOST}/`;
  return [
    `CREATE OR REPLACE SECRET ${FABRIC_STORAGE_SECRET} (TYPE azure, PROVIDER access_token, ACCESS_TOKEN ${value}, ACCOUNT_NAME 'onelake', ENDPOINT ${quoteLiteral(ONELAKE_HOST)}, SCOPE ${quoteLiteral(scope)})`,
    `CREATE OR REPLACE SECRET ${SECRET} (TYPE iceberg, TOKEN ${value})`,
  ];
}

function attachStatement(target: IcebergTarget): string {
  const options = [
    'TYPE iceberg',
    `ENDPOINT ${quoteLiteral(target.endpoint)}`,
    ...(target.signIn === 'none' ? [] : [`SECRET ${SECRET}`]),
    ...(target.fabric
      ? ["ACCESS_DELEGATION_MODE 'none'", 'STAGE_CREATE_TABLES false', 'DISABLE_MULTI_TABLE_COMMIT true']
      : [
          ...(target.vendedCredentials ? ["ACCESS_DELEGATION_MODE 'vended_credentials'"] : []),
          `DEFAULT_REGION ${quoteLiteral(target.region)}`,
        ]),
  ];
  return `ATTACH ${quoteLiteral(target.warehouse)} AS ${ICEBERG} (${options.join(', ')})`;
}
