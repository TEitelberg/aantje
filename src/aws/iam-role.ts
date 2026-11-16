// The role that IAM database authentication signs in as on PostgreSQL of an AWS lake: `ducklake_iam`, created once by
// the administrator after the stack. A role with `rds_iam` takes only IAM tokens, so the administrator keeps its
// password login as the way in when IAM fails (after a reset of the master password in the RDS console). Free of the VS
// Code API.

/** The role of IAM database authentication; the output of the template names it when `IamAuthentication` is true. */
export const IAM_ROLE = 'ducklake_iam';

/** The administrator of the template (the default of `MasterUsername`, which aantje does not change). */
export const ADMIN_USER = 'ducklakeadmin';

/** Where and as whom the administrator connects, with the password generated for the lake. */
export interface AdminConnection {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * Creates the role, lets it sign in with IAM and gives it the database, so that DuckLake creates its tables as that
 * role on the first attach. Each statement can run again, for Finish Creating after a break.
 */
export function iamRoleStatements(database: string): string[] {
  return [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${IAM_ROLE}') THEN CREATE ROLE ${IAM_ROLE} WITH LOGIN; END IF; END $$`,
    `GRANT rds_iam TO ${IAM_ROLE}`,
    // The administrator must be a member of the role to hand the database over to it.
    `GRANT ${IAM_ROLE} TO ${ADMIN_USER}`,
    `ALTER DATABASE ${quoteIdentifier(database)} OWNER TO ${IAM_ROLE}`,
  ];
}
