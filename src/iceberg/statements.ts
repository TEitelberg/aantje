import { quoteLiteral } from '../catalog/ddl';
import { oauth2ServerUriOf } from './target';
import type { IcebergTarget } from './target';

/** Name under which the Iceberg catalog is attached. */
export const ICEBERG = 'ice';
const SECRET = 'aantje_iceberg';

/**
 * SQL that attaches the catalog of a target: the extensions (loaded before the configuration lock) and the secret and
 * ATTACH (after the lake is attached). The secret appears only in `CREATE SECRET`.
 */
export function icebergSetup(
  target: IcebergTarget,
  secret: string | undefined,
): { readonly extensions: string[]; readonly attach: string[] } {
  const attach: string[] = [];
  if (target.signIn === 'oauth2') {
    const scope = target.scope === undefined ? '' : `, OAUTH2_SCOPE ${quoteLiteral(target.scope)}`;
    attach.push(
      `CREATE OR REPLACE SECRET ${SECRET} (TYPE iceberg, CLIENT_ID ${quoteLiteral(target.clientId ?? '')}, CLIENT_SECRET ${quoteLiteral(secret ?? '')}, OAUTH2_SERVER_URI ${quoteLiteral(oauth2ServerUriOf(target))}${scope})`,
    );
  } else if (target.signIn === 'token') {
    attach.push(`CREATE OR REPLACE SECRET ${SECRET} (TYPE iceberg, TOKEN ${quoteLiteral(secret ?? '')})`);
  }
  const options = [
    'TYPE iceberg',
    `ENDPOINT ${quoteLiteral(target.endpoint)}`,
    ...(target.signIn === 'none' ? [] : [`SECRET ${SECRET}`]),
    ...(target.vendedCredentials ? ["ACCESS_DELEGATION_MODE 'vended_credentials'"] : []),
    `DEFAULT_REGION ${quoteLiteral(target.region)}`,
  ];
  attach.push(`ATTACH ${quoteLiteral(target.warehouse)} AS ${ICEBERG} (${options.join(', ')})`);
  return { extensions: ['INSTALL httpfs', 'LOAD httpfs', 'INSTALL iceberg', 'LOAD iceberg'], attach };
}
