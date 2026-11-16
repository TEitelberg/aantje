# AWS DuckLake

**aantje: Create AWS DuckLake...** (in the `...` menu of the view title, and in the empty view) creates a DuckLake in your AWS account and adds it as a connection: PostgreSQL on Amazon RDS as the catalog and an S3 bucket for the data files, in one CloudFormation stack. **aantje: Finish Creating AWS DuckLake...** picks up a creation whose wait broke off ([below](#when-waiting-breaks-off)).

**aantje: Import AWS DuckLake...** adds a lake that the template of the repository created by hand (AWS CLI or console) ([below](#importing-a-stack-created-by-hand)). **Allow My IP** lets your current public IP reach PostgreSQL again, and **Delete AWS DuckLake...** removes a lake that aantje created ([below](#deleting-a-lake)); both are in the last section of the context menu of an AWS DuckLake (a PostgreSQL connection on `*.rds.amazonaws.com` whose storage is S3), and of no other connection. The sign-in to PostgreSQL with IAM database authentication follows (issue #2). There is no Copy AWS Config: the Docker stack has no notebooks for an AWS lake.

The code is in `src/aws/`. The template is `deploy/aws/template.yaml`; [its README](../../deploy/aws/README.md) has the parameters and the call of the AWS CLI.

| File                                | Job                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api.ts`                            | What aantje asks of AWS, in its own terms (`AwsApi`), and the error of a failed call                                                             |
| `sdk.ts`, `sdk-bucket.ts`           | `AwsApi` with the AWS SDK for JavaScript (`sdk.ts` is the entry of `dist/aws-sdk.js`, `sdk-bucket.ts` the S3 calls); the only files with the SDK |
| `load.ts`                           | Loads `dist/aws-sdk.js` when an AWS command runs                                                                                                 |
| `profiles.ts`                       | The profiles of `~/.aws/config` and `~/.aws/credentials`, and the keys of the environment                                                        |
| `stack.ts`                          | The checks, the change set, the stack, the wait, the cleanup of a failed creation                                                                |
| `permissions.ts`                    | The principal of the credentials and the actions that IAM's policy simulation checks                                                             |
| `create-flow.ts`                    | The dialogs of create and finish, on top of `WizardUi`                                                                                           |
| `follow.ts`                         | Following a stack update or delete                                                                                                               |
| `allow-ip.ts`                       | Allow My IP: a stack update of `ClientIp`; the stack of an imported lake found by its host                                                       |
| `delete-lake.ts`, `delete-flow.ts`  | The checks and steps of a delete, and its dialog                                                                                                 |
| `import-flow.ts`                    | The import of the output of a stack                                                                                                              |
| `pending.ts`, `registry.ts`         | A started stack until it is a connection; the lakes that aantje created                                                                          |
| `outputs.ts`, `lake-profile.ts`     | The `ducklake` output of the stack, and the connection made of it                                                                                |
| `names.ts`, `sizes.ts`, `errors.ts` | Stack and bucket names, the two sizes, readable messages for failed calls                                                                        |
| `commands.vscode.ts`                | The commands and the notices of an interrupted creation; the only file that imports `vscode`                                                     |

The generated password, the IP lookup, the first attach and its retry are those of the [Azure DuckLake](azure-lake.md) (`src/azure/password.ts`, `public-ip.ts`, `attach-lake.ts`, `retry.ts`).

## What is created

| Resource                                        | Small                      | Medium                      |
| ----------------------------------------------- | -------------------------- | --------------------------- |
| RDS for PostgreSQL (newest of 18 to 14 offered) | `db.t4g.small`, 32 GiB gp3 | `db.m7g.large`, 128 GiB gp3 |
| Availability                                    | Single-AZ                  | Multi-AZ                    |

Both sizes also get:

- **A VPC of its own** (`10.42.0.0/16`) with two subnets in two availability zones (the DB subnet group needs two), an internet gateway and a route to it; no NAT gateway. The lake depends on no default VPC and goes with the stack.
- **A security group** that admits TCP 5432 from your public IPv4 address only (`/32`, the rule `client-ip`).
- **A parameter group** with `rds.force_ssl = 1`: the server refuses a connection without TLS.
- **The instance** with the database `ducklake_catalog`, the administrator `ducklakeadmin` and a generated password, public access (the security group decides who reaches it), storage encrypted with the key that AWS manages for RDS, deletion protection on, seven days of backups, minor version upgrades on.
- **The S3 bucket** `aantje-<name>-<suffix>`: Block Public Access fully on, Object Ownership `BucketOwnerEnforced` (no ACLs), SSE-S3 encryption, and a bucket policy that denies every request without TLS and lets the principal that created the lake read and write the data (the counterpart of the storage role of the Azure lake).
- **The tag** `aantje:lake` with the name of the lake on every resource that takes tags, and on the stack.

Only keys that AWS manages, so that deleting a lake leaves no customer managed key in its 7 to 30 days of pending deletion. The data path is `s3://<bucket>/data/`; DuckLake creates its tables in the catalog on the first attach.

The database is created last: every other resource is ready before it starts, so a failure rolls back before the database exists, and its deletion protection never blocks a rollback.

## Cost

The resources cost money for as long as they exist, also when nobody uses them: RDS per hour of the instance, its storage and backups, and the data in S3. The VPC, its subnets, the internet gateway and the security group cost nothing by themselves; RDS has a public IPv4 address, which AWS bills by the hour. aantje shows no prices, because they differ by region, change over time and depend on your agreement. Price the sizes with the [AWS Pricing Calculator](https://calculator.aws/). Delete a lake you no longer need.

## The wizard

1. **AWS profile.** In the workbench of the Docker stack, create one first in its terminal with the AWS CLI of the image ([Docker stack](../../docker/README.md#aws-profiles-in-the-workbench)). aantje lists the profiles of `~/.aws/config` and `~/.aws/credentials` (or of the files that `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` name), marks those of IAM Identity Center, and offers **Environment** when `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are set. Any sign-in of the profile works: IAM Identity Center after `aws sso login --profile <name>`, assume role, a credential process, keys. aantje stores no AWS credentials.
2. **Account.** aantje asks AWS who the credentials belong to (`sts:GetCallerIdentity`) and asks you to confirm the account ID and the principal.
3. **Region**: the regions that the account has enabled, the region of the profile first.
4. **Name**: 3 to 24 lower-case letters, digits and hyphens. It goes into the stack and bucket names and the tag.
5. **Size.** aantje reads which major versions of PostgreSQL RDS offers in the region and takes the newest of 18 to 14, then whether each size is offered with it (gp3, Multi-AZ for Medium). A size that the region lacks is listed with the reason and refused.
6. **Sign-in to PostgreSQL**: **Password** (the default) or **AWS IAM** ([below](#signing-in)).
7. **IP.** aantje looks up your public IPv4 address, as for the Azure lake ([The IP lookup](azure-lake.md#the-ip-lookup)); if that fails you type it.

Then the checks run, and the change set is shown before anything costs money:

- **Names.** The stack `aantje-<name>-<suffix>` must not exist in the region, and no bucket of that name may exist anywhere (`s3:HeadBucket`). The suffix is 12 random hex digits, new for every run.
- **Quotas.** DB instances of the account in the region (`rds:DescribeAccountAttributes`), and VPCs against the quota "VPCs per Region" of Service Quotas. A full quota stops the run. When Service Quotas cannot be read and the account has five VPCs or more (the default quota), aantje asks whether to go on.
- **Permissions.** aantje asks IAM's policy simulation (`iam:SimulatePrincipalPolicy`) whether your principal may run the actions that creating and rolling back the stack need (CloudFormation, EC2, RDS, S3). An IAM user is its own ARN; for an assumed role (also IAM Identity Center) aantje reads the ARN of the role with its path (`iam:GetRole`). When the simulation denies an action, or cannot run (it is not allowed, or the ARN of the role cannot be read), aantje says so and asks whether to go on. The simulation does not see service control policies or every condition, so CloudFormation can still refuse; the cleanup below handles that. The root user is not checked.
- **Change set.** aantje creates the stack through a change set (`ChangeSetType CREATE`) and shows the resources it creates, where PostgreSQL can be reached from, and the cost note. **Create** executes it; anything else deletes the empty stack (`REVIEW_IN_PROGRESS`) together with its change set, and nothing was created.

The password is generated (32 characters, random) and goes to CloudFormation only as the `NoEcho` parameter `MasterPassword`. Before the change set runs, aantje keeps the account, region, profile, stack and bucket in the global state of the editor and the password in the secret storage ([below](#when-waiting-breaks-off)).

aantje then follows the stack every 15 seconds and logs each resource as it ends. When the stack is complete, aantje switches on its termination protection, saves the connection, then attaches the lake once: DuckLake creates its tables, and a listing of the bucket proves that the data can be read. If the attach fails, the connection stays and the message says so.

## When the creation fails

CloudFormation rolls a failed creation back. aantje then reads the events of the stack, names the first resource that failed with CloudFormation's reason, deletes the stack in `ROLLBACK_COMPLETE` (it holds nothing, but it would block its name) and links the stack in the CloudFormation console. A stack whose rollback failed is left as it is: the message says that what it created costs money until you delete the stack in the console.

## When waiting breaks off

A request without an answer, throttling or a server error is tried again, with a doubled pause each time; the fourth failure in a row ends the wait. The wait also ends after 60 minutes. Either way the stack goes on in AWS, and the message names it. Closing the editor does not stop it either.

When aantje starts and a creation is still pending, a warning names it with its region and offers **Finish**, as for the Azure lake: it waits until the view of aantje is visible and names only what was pending when the window started. A lake that was saved but whose first attach did not finish is offered **Attach now**.

**aantje: Finish Creating AWS DuckLake...** lists the interrupted creations. It opens the profile of the lake, checks that the credentials belong to the account of the stack, waits for the stack again and, once it is complete, saves and attaches the lake with the kept password. A stack whose change set never ran is deleted; a stack that is gone is forgotten.

## Signing in

| Part           | Sign-in                                                                                                                                                                                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL     | **Password** (the default): the administrator `ducklakeadmin` and its generated password in the secret storage, like any PostgreSQL connection. **AWS IAM**: the role `ducklake_iam` with a token of IAM database authentication as the password, signed with the profile of the creation for every connection; no password is stored. |
| The data files | `storage` of kind `aws` with the region of the lake and `signIn` `chain`: DuckDB's AWS credential chain with the profile of the creation (`awsProfile`) and the providers `sso;config;process`, or the chain `env` for the environment ([Data access](data-access.md#storage-of-a-connection)).                                        |

**AWS IAM.** The template switches IAM database authentication on (`IamAuthentication` `true`), and its output names the user `ducklake_iam` and the sign-in `iam`. A role with `rds_iam` takes only IAM tokens, so aantje creates a role of its own once the stack is complete, connecting as `ducklakeadmin` with the generated password over TLS: `CREATE ROLE ducklake_iam WITH LOGIN`, `GRANT rds_iam TO ducklake_iam`, `GRANT ducklake_iam TO ducklakeadmin` (so the administrator may hand the database over) and `ALTER DATABASE ducklake_catalog OWNER TO ducklake_iam`, so that DuckLake creates its tables as that role on the first attach. Each statement can run again, so Finish Creating repeats them. Then the password of the administrator is not kept: the connection signs in with tokens, and the administrator stays the way in when IAM fails, after a reset of its master password in the RDS console. If the password is gone before the role exists (an interrupted run whose secret was lost), Finish says how to create the role by hand.

The token is signed for the host, port, user and region with the credentials of the profile (`@aws-sdk/rds-signer` in `dist/aws-sdk.js`); the explorer gets a new one for every connect, and a long SQL session replaces the PostgreSQL secret with a new one every ten minutes, as for an Entra token. The principal needs `rds-db:connect` on the user (`arn:aws:rds-db:<region>:<account>:dbuser:<resource id>/ducklake_iam`): IAM's policy simulation checks it with the other actions when you choose AWS IAM. Tokens are registered with the log redactor and never stored.

The chain of a profile leaves out `env` on purpose: DuckDB's default chain asks the environment first, and keys there may belong to another store (in the workbench of the Docker stack they are the RustFS keys), which would then be used instead of the profile.

The certificates of RDS come from the Amazon RDS certificate authorities, which are not in the system trust store. aantje ships their bundle (`deploy/aws/rds-ca-bundle.pem`, from `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`, copied to `dist/rds-ca-bundle.pem` by the build) and checks every server whose host ends in `.rds.amazonaws.com` against it: the explorer passes it to the PostgreSQL driver as its certificate authorities, the data engine as `SSLROOTCERT`. Both still check the host name (`verify-full`). Any other host is checked against the system trust store as before. A unit test checks that the bundle holds only certificate authorities of Amazon that stay valid for at least five years. To update it, download the file again from that address and run the tests.

## Allow My IP

When your address changes (home office, VPN) the connection fails: the security group drops the packets, so the connect ends in a timeout. A failed **Connect** of an AWS DuckLake that looks like this offers the button **Allow my IP**; the command is also in the context menu of the lake.

The command:

1. looks up your public IP (as for the [Azure DuckLake](azure-lake.md#the-ip-lookup));
2. finds the stack: a lake that aantje created knows it; for an imported lake aantje looks among the stacks of the region of its storage for the one whose output `PostgresHost` is the host of the connection, with the profile of its storage;
3. asks you to confirm the address, and names the one it replaces;
4. updates the stack with its original template (`cloudformation:GetTemplate`, stage `Original`) and the new value of the parameter `ClientIp`, all other values as they are, and follows the update. Not with `UsePreviousTemplate`: a stack of the first template of aantje used the transform `AWS::LanguageExtensions`, which wrote the parameter values into the processed template as literals, so a new value would change nothing.

The rule `client-ip` of the security group is changed by CloudFormation, never directly, so the stack does not drift. Only that parameter changes, and only to a single IPv4 address (`/32`). A stack that has no parameter `ClientIp` was not made from the template of aantje; change its security group in the EC2 console. AWS decides whether your credentials may update the stack (`cloudformation:UpdateStack`, and the EC2 actions of the security group). If the address is allowed already, nothing changes and the message says that the cause is another one.

## Importing a stack created by hand

The output `ducklake` of the stack is JSON with a ready `ATTACH` statement, the region and bucket, and the host, database and user of PostgreSQL; never the password ([deploy/aws/README.md](../../deploy/aws/README.md)). **Import AWS DuckLake...** takes it from the clipboard or a box, asks for a connection name, the AWS profile that reads the bucket (or the environment), the sign-in (AWS IAM is preselected when the output says `iam`; the same profile then signs the tokens) and, for Password, the password of the user, tests the connection and saves it with `storage` of kind `aws` and the chain `sso;config;process` of the profile, as for a lake that aantje created. An imported lake counts as not created by aantje, so **Delete AWS DuckLake...** does not remove its stack.

## Deleting a lake

**Delete AWS DuckLake...** is in the context menu of an AWS DuckLake and works only for lakes that aantje created; for an imported lake it says that it does not delete resources it did not create (the stack, account and region are kept in the global state of the editor). It asks for the name of the lake to be typed, whether RDS keeps a final snapshot of the catalog (it costs until you delete it), and for a last confirmation that names the stack, the database, the bucket and the VPC. After a delete that stopped, it asks for no snapshot when the database is gone or being deleted already. From the confirmation on, aantje notes the delete in the global state of the editor (the time, and the final snapshot as soon as RDS deletes the database with it). Then, under a progress notification:

1. It opens the profile of the lake and checks that the credentials belong to the account of the stack, that the stack carries the tag `aantje:lake`, and that its output names the host of the connection. Anything else stops the command before a change.
2. It deletes the database itself: it switches off its deletion protection in RDS (`rds:ModifyDBInstance`, at once), waits until the instance is available, deletes it with a final snapshot named `<instance>-final-<date>-<time>` or without one (`rds:DeleteDBInstance`), and waits until it is gone. This changes the database outside the stack on purpose: the stack goes anyway, a stack update could not do it for a stack of the first template (see Allow My IP), and a stack in `DELETE_FAILED` takes no update at all.
3. It switches off the termination protection of the stack.
4. It empties the bucket: every object, every version and delete marker, and the unfinished multipart uploads. CloudFormation does not delete a bucket that holds anything.
5. It deletes the stack and follows its events until it is gone. If the stack fails only at its database record (a stack that failed before), aantje deletes it once more and retains that record (`RetainResources`), because the database is gone already.

A call that gets no answer, is throttled or meets a server error is asked again up to three times, with a longer pause each time (30 seconds, then 1 and 2 minutes), as the polls of the database and of the stack are. Only `rds:DeleteDBInstance` is not: a second request after one that arrived would fail, and the next run finds the database deleting.

The steps can run again: a database that is gone, an empty bucket and a stack in `DELETE_FAILED` are taken as they are. Deleting the stack by hand in the console keeps a final snapshot (the `DeletionPolicy` of the database is `Snapshot`), once its deletion protection is off.

At the end aantje reports what is left: the final snapshot that RDS keeps (by its name, also one that an earlier run took), or the resources that CloudFormation could not delete, with its reasons and a link to the stack in the console. Only when the stack is gone are the connection, its password, its trust, its history and the note of the delete removed; after a failed delete the connection stays, so the command can run again.

**A delete that stops** (no answer from AWS for minutes, the editor closed) says what it did before: for example that the database is gone and the termination protection is off, and that running **Delete AWS DuckLake...** again goes on from there. The note stays, also across restarts, and the explorer shows it on the connection in every status: a red icon, `delete unfinished` before the description, and in the tooltip when the delete started, that the database may be gone (so connecting fails with a host name that cannot be resolved), and to run Delete again. Azure DuckLakes have no such note: Delete Azure DuckLake removes the connection once Azure has taken the delete.

## What the output shows

The output channel **aantje** logs every step: the choices (account, principal, profile, region, size, PostgreSQL version, client IP), the checks and their results, the change set with a link to the stack in the CloudFormation console, each change of the state of the stack, each resource that ended (warnings for those that failed), the termination protection, the saved connection (host, database, user, bucket, data path) and the first attach; for **Delete**, the lake, the stack update, the objects removed from the bucket, the end of the stack and the final snapshot; for **Allow My IP** and **Import**, the stack, the address it replaced, the connection test. At the level Debug it logs every request to AWS: the operation, the status, the duration and the request id. Never logged: the password and any credentials; the password is registered with the log redactor.

## What is verified, and what is not

**Run against a real account (2026-11-15, in the workbench of the Docker stack):** Create AWS DuckLake with a profile of an IAM user (access keys) in `eu-central-1`, size Small, PostgreSQL 18. The account check, the free names, the quotas and IAM's policy simulation passed; the change set was created and shown; the stack was complete after 9 minutes, its termination protection went on, the connection was saved, and the first attach took 21 seconds: DuckDB accepted the certificate of RDS against the shipped bundle and listed the bucket with the credential chain of the profile. The explorer connected with the same bundle.

**Delete, first run (2026-11-15):** the first version switched the deletion protection off with a stack update. CloudFormation answered that there was nothing to update: the stack used `AWS::LanguageExtensions`, whose processed template has the parameter values as literals (checked with `get-template --template-stage Processed`), and an update with `UsePreviousTemplate` takes that template. The bucket was emptied, and the stack ended in `DELETE_FAILED` at its protected database. Delete now deletes the database itself, the template has no transform any more, and Allow My IP sends the original template. **Second run** of Delete on that stack in `DELETE_FAILED`: the deletion protection went off, the database was deleted without a final snapshot in about a minute and a half, the bucket was empty already, and the stack was deleted in 32 seconds; CloudFormation took the database that was gone as deleted, so no second delete with `RetainResources` was needed. The connection went with it.

**AWS IAM, and a delete that stopped (2026-11-15, the same workbench and account):** Create AWS DuckLake with the sign-in AWS IAM. The simulation allowed every action, `rds-db:connect` included. The wait for the stack broke off after 11 minutes at a single connect timeout, which the extension did not take as a passing failure (`instanceof` against the second copy of `AwsCallError` in `dist/aws-sdk.js`, fixed since). **Finish Creating** found the stack complete, created the role `ducklake_iam` as `ducklakeadmin` and saved the connection without a password. The first attach (DuckDB with a token as the password of its PostgreSQL secret) took 13 seconds, and the explorer connected with a token too. Delete then deleted the database; the workbench had no connection to AWS for some minutes, the wait for the database lived through it, and the next call (`cloudformation:UpdateTerminationProtection`) stopped the delete. That left the stack with an empty bucket and the connection, which only said that the host name could not be resolved. The note of an unfinished delete, the calls that are asked again and the message of a delete that stops come from this run (#83).

**Checked without AWS:** the template passes `cfn-lint` (`npm run check:aws-template`, in CI), and its security settings, tags, order and output are pinned by unit tests; the output of the template is read by the same code as a stack's. The rollback and its cleanup, a declined change set, a denied or impossible simulation, the pending record, Finish, the order of the steps of Delete and its refusals, Allow My IP of a created and an imported lake, and Import are covered by unit tests with a fake of `AwsApi`.

**Not verified; these questions are open:**

- A profile of IAM Identity Center (or assume role), in the SDK and in DuckDB's chain `sso;config;process`.
- AWS IAM in a long session: the renewal of the token in the PostgreSQL secret of DuckDB after ten minutes.
- A second run of Delete against AWS after one that stopped, with the note in the explorer.
- A failed creation and a declined change set against AWS itself: the error names that aantje reads there (`ValidationError ... does not exist`) and the events of a rollback.
- Allow My IP and Import against AWS: the stack update with the original template, and the lookup of an imported lake's stack by its host.
- Whether the actions that the simulation checks are all that CloudFormation calls for this template (the run above had them all).

Before a release, run the wizard once in a test account and delete the lake again.
