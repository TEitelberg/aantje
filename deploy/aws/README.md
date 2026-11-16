# AWS DuckLake template

`template.yaml` creates a DuckLake in an AWS account: PostgreSQL on Amazon RDS as the catalog and an S3 bucket for the data files, in a VPC of its own, in one CloudFormation stack. **aantje: Create AWS DuckLake...** uses this file; the AWS CLI and the CloudFormation console take the same file. What it creates and why is described in [AWS DuckLake](../../docs/en/aws-lake.md).

## Parameters

| Parameter            | Default         | Meaning                                                                                                                       |
| -------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `LakeName`           |                 | 3 to 24 lower-case letters, digits and hyphens; the value of the tag `aantje:lake` on every resource                          |
| `Size`               | `small`         | `small`: `db.t4g.small`, 32 GiB gp3, Single-AZ. `medium`: `db.m7g.large`, 128 GiB gp3, Multi-AZ                               |
| `PostgresVersion`    | `17`            | The major version, `14` to `18`; RDS takes its default minor version. It must be offered in the region                        |
| `BucketName`         |                 | The bucket of the data files; bucket names are global, so choose one that is free                                             |
| `ClientIp`           |                 | Your public IPv4 address; the security group admits it as `/32` on port 5432                                                  |
| `MasterUsername`     | `ducklakeadmin` | The administrator of PostgreSQL                                                                                               |
| `MasterPassword`     |                 | 16 to 128 letters, digits, `-` and `_` (`NoEcho`)                                                                             |
| `IamAuthentication`  | `false`         | `true`: PostgreSQL also takes IAM database authentication; the output names the role `ducklake_iam` (create it, below)        |
| `PrincipalArn`       | empty           | The IAM user or role (ARN with path) that the bucket policy lets read and write the data; empty: only the IAM policies decide |
| `DeletionProtection` | `true`          | Whether RDS refuses to delete the database                                                                                    |

Deleting the stack keeps a final snapshot of the database (its `DeletionPolicy` is `Snapshot`), once `DeletionProtection` is off; the snapshot costs until you delete it. **Delete AWS DuckLake...** deletes the database itself first, with a final snapshot or without one.

With `IamAuthentication` `true` the output names the user `ducklake_iam`, a role that the stack cannot create. Connect once as the administrator (TLS, the CA bundle of this folder) and run:

```sql
CREATE ROLE ducklake_iam WITH LOGIN;
GRANT rds_iam TO ducklake_iam;
GRANT ducklake_iam TO ducklakeadmin;
ALTER DATABASE ducklake_catalog OWNER TO ducklake_iam;
```

**Create AWS DuckLake...** does this itself. The principal that connects needs `rds-db:connect` on that user.

## With the AWS CLI

```sh
aws cloudformation deploy \
  --template-file deploy/aws/template.yaml \
  --stack-name aantje-sales \
  --tags aantje:lake=sales \
  --parameter-overrides \
    LakeName=sales \
    BucketName=aantje-sales-<something-unique> \
    ClientIp=203.0.113.7 \
    MasterPassword=<a password> \
    PrincipalArn=<your user or role ARN>
aws cloudformation update-termination-protection --stack-name aantje-sales --enable-termination-protection
aws cloudformation describe-stacks --stack-name aantje-sales --query "Stacks[0].Outputs[?OutputKey=='ducklake'].OutputValue" --output text
```

**aantje: Import AWS DuckLake...** turns that output into a connection; Allow My IP then works for the stack, Delete does not (aantje deletes only what it created). The output `ducklake` is JSON with a ready `ATTACH` statement, the region and bucket for the S3 secret, and the host, database and user of PostgreSQL; never the password. Its `sslrootcert=rds-ca-bundle.pem` means the file `rds-ca-bundle.pem` of this folder (the certificate authorities of Amazon RDS, from `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`): pass its path. A DuckDB secret for the data files:

```sql
CREATE SECRET (TYPE s3, PROVIDER credential_chain, PROFILE '<your profile>', REGION '<region>');
```

## Checks

`npm run check:aws-template` lints the template with `cfn-lint` (where it is installed; CI installs it) and checks that CloudFormation takes it as a `TemplateBody` (at most 51,200 bytes). The unit tests in `test/unit/aws-template.test.ts` pin its security settings, tags, the order of the database and its output.
