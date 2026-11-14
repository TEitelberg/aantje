# Azure DuckLake

**aantje: Create Azure DuckLake...** (in the `...` menu of the view title) creates a DuckLake in your Azure subscription and adds it as a connection. **aantje: Finish Creating Azure DuckLake...** picks up a deployment whose wait broke off ([below](#when-waiting-breaks-off)). **aantje: Import Azure DuckLake...** adds a lake that the template of the repository created in the portal or in a pipeline. **Delete Azure DuckLake...** removes a lake that aantje created. **Allow My IP** lets your current public IP reach the server again. **Copy Azure Config** puts the values for the Azure notebooks of the Docker stack on the clipboard ([below](#copy-azure-config)). These three are together in the last section of the context menu of an Azure DuckLake (created or imported), and of no other connection. Create Notebook is offered on its tables and views like on any other connection; the notebook signs in to the storage itself ([Notebooks](notebooks.md#storage-sign-in-in-the-notebook)).

The code is in `src/azure/`. The template is `deploy/azure/main.bicep`, compiled to `deploy/azure/azuredeploy.json`; [its README](../../deploy/azure/README.md) has the **Deploy to Azure** button and the parameters.

| File                                            | Job                                                                                      |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `arm.ts`, `arm-errors.ts`                       | The Azure Resource Manager client and readable error messages                            |
| `arm-transport.ts`, `poll.ts`                   | The requests with the token and the API versions; the poll that outlasts a few failures  |
| `arm-discovery.ts`                              | Tenants, subscriptions, regions, free names, what a region offers                        |
| `arm-deployments.ts`, `arm-firewall.ts`         | Azure's check of the deployment, the deployment, the deletes and the rule of Allow My IP |
| `operations.ts`                                 | Deployment operations, the addresses of accepted deletes, durations for the log          |
| `create-lake.ts`                                | The checks and the deployment of the embedded template                                   |
| `allow-ip.ts`, `blocked-ip.ts`                  | The Allow My IP command, and the test that offers it after a failed connect              |
| `config-export.ts`                              | The text that Copy Azure Config puts on the clipboard                                    |
| `delete-lake.ts`, `registry.ts`                 | Deleting a lake, and the record of the lakes that aantje created                         |
| `pending.ts`                                    | The names and the password of a started deployment, until it is a connection             |
| `attach-lake.ts`                                | The first attach of a new lake, with a retry while the role takes effect                 |
| `create-flow.ts`, `import-flow.ts`              | The create and finish dialogs, and the import dialog, on top of `WizardUi`               |
| `delete-flow.ts`, `lake-profile.ts`             | The delete dialog; the connection of a lake, its name and the sign-in question           |
| `jwt.ts`, `names.ts`, `password.ts`, `sizes.ts` | Token claims, resource names, the generated password, the two sizes                      |
| `public-ip.ts`, `retry.ts`, `lake-outputs.ts`   | The IP lookup, the backoff, the `ducklake` output of the template                        |
| `auth.vscode.ts`, `commands.vscode.ts`          | The Microsoft sign-in of VS Code and the commands; the only files that import `vscode`   |

## What is created

| Resource                                                                     | Small                             | Medium                                      |
| ---------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------- |
| PostgreSQL flexible server (newest of 17, 16, 15, 14 that the region offers) | Burstable `Standard_B1ms`, 32 GiB | General Purpose `Standard_D2ds_v5`, 128 GiB |
| High availability                                                            | off                               | off                                         |
| Storage account (ADLS Gen2, `StorageV2`)                                     | `Standard_LRS`                    | `Standard_ZRS`                              |

Both sizes also get the database `ducklake_catalog`, the container `lake`, one firewall rule (`client-ip`) and one role assignment. With Entra authentication there is a second server setting and the Entra administrator (below). The wizard offers nothing else on purpose; change SKU, disk or redundancy later on the resources themselves.

- **PostgreSQL** has public access with one firewall rule for your current public IPv4 address, and `require_secure_transport` on. There is no `0.0.0.0` rule, so other Azure services and other addresses cannot connect. The local administrator is `ducklakeadmin` with a generated password.
- **Storage** has shared key access off, public blob access off and TLS 1.2 as the minimum. Access goes through Microsoft Entra only.
- **The `attach` statement** in the deployment output connects with `sslmode=verify-full sslrootcert=system`, so the client checks the certificate and host name of the server; this matters most in Entra mode, where the password is an access token. A client without the system root certificates needs `sslrootcert` pointed at them.
- **Role.** You get **Storage Blob Data Contributor** on the storage account (not on the resource group or subscription). The object ID comes from the `oid` claim of your sign-in token; there is no field for it.
- DuckLake creates its tables in the catalog on the first attach. The data path is `abfss://lake@<account>.dfs.core.windows.net/data/`.

## Cost

The resources cost money for as long as they exist, also when nobody uses them: the PostgreSQL server, its disk and backups, and the stored data. aantje shows no prices, because they differ by region, change over time and depend on your agreement. Price the sizes for your region with the [Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/): a PostgreSQL flexible server with the compute size and disk of the table above, and a storage account with the redundancy of the table. Delete a lake you no longer need.

## The wizard

1. Sign in with the Microsoft account of VS Code. With several tenants (directories) you pick one; aantje then asks VS Code for tokens with the scope `VSCODE_TENANT:<id>`.
2. Pick the subscription, the resource group (an existing one, or a new one that aantje creates), the region, a name (the prefix of the resource names) and the size. A size that the region does not offer is listed with the reason and refused. If the lookup of the offers fails, the size stays selectable and Azure decides when the deployment starts.
3. Choose how you sign in to PostgreSQL: **Password** or **Microsoft Entra** ([below](#signing-in-to-postgresql)).
4. aantje looks up your public IP (below) and shows a summary with the cost note. **Create** starts the work.
5. aantje checks that the storage account and server names are free, then lets Azure check the deployment before it starts it ([below](#azures-check-before-the-deployment)). If a check fails, it stops with a message and deploys nothing; a new resource group, which Azure's check needs, is deleted again.
6. The deployment runs under a progress notification. The password is generated (32 characters, random, with upper and lower case letters, digits and `-` or `_`). With the password mode it goes to the secret storage in the same way as the password of any PostgreSQL connection; it is never shown. With Entra it is not kept ([below](#signing-in-to-postgresql)). Before the deployment starts, aantje keeps the names and the password until the lake is a connection, so an interrupted wait loses nothing ([below](#when-waiting-breaks-off)).
7. The connection is saved, then attached once: DuckLake creates its schema, and a listing of the container proves that the role works. While the role is not yet effective, the attach is repeated with a growing wait (5 s doubling to 30 s, at most 12 tries). If it still fails, the connection stays and the message says so; the Azure resources exist and cost money.

The resource group keeps the name that you picked or typed. The server and the storage account get the name and a suffix of 13 hex digits from a new random GUID, the rule of the template's default `uniqueSuffix`. aantje draws the suffix before the deployment, so it can ask Azure whether the names are free and keep them in case the wait breaks off. Every run draws a new suffix: running the wizard again with the same answers creates a second lake next to the first, and nothing is updated. A run whose wait broke off is finished with **Finish Creating Azure DuckLake...** ([below](#when-waiting-breaks-off)); the resources of a failed run are deleted in the portal. If Azure's check or the start refuses the deployment, nothing was created but a new resource group: aantje deletes the group it created for this run and says so.

### Azure's check before the deployment

aantje does not evaluate your permissions itself; Azure decides. Before the deployment starts, aantje sends the same template and parameters to `.../providers/Microsoft.Resources/deployments/<name>/validate`, at the scope and API version of the deployment (Azure's preflight validation). Azure checks the template, the parameters and whether your account may create every resource of it, without creating anything. A new resource group is created before this check, because the check runs in the group. An answer that Azure gives later (202) is waited for.

The template creates a role assignment, which needs `Microsoft.Authorization/roleAssignments/write`: Owner and User Access Administrator have it, Contributor does not. When Azure refuses a permission (the code `AuthorizationFailed` or `LinkedAuthorizationFailed` at any depth of its answer, or the text `Authorization failed for template resource`), the command stops with an `AUTH_FAILED` message: Azure's check refused your account a permission in the resource group (in this subscription for a new group); ask for the role Owner or User Access Administrator, or choose another resource group. One more sentence says that the check may miss a role that your account has only through a management group, and that assigning the role on the subscription or the resource group then helps. Azure's own words follow. Any other refusal shows what Azure said, with the hint of a known cause.

### The IP lookup

The firewall rule admits the address that the lookup returns. aantje makes one HTTPS request to `https://api.ipify.org` and uses the answer only if it is an IPv4 address. If the request fails you type the address (when creating a lake). The service is called when you create a lake and when you run Allow My IP, and aantje does not store the address.

## When waiting breaks off

Before the deployment starts, aantje keeps what only it knows: the subscription, the resource group, the deployment `aantje-lake-<suffix>` and the expected resource names in the global state of the editor, and in the password mode the generated password in the secret storage. Both stay until the lake is saved as a connection.

While it waits, aantje reads the state of the deployment every 5 seconds. A request without an answer (the network is gone for a moment, a Wi-Fi or VPN switch), a server error or an expired token is tried again; each failure in a row waits twice as long (10, 20, 40 s), and the fourth in a row ends the wait. The wait also ends after 45 minutes. Either way the deployment goes on in Azure, and the message names it.

Closing the editor or reloading the window does not stop the deployment: Azure runs it on its own. When aantje starts and a deployment is still pending, a warning names it with its resource group and offers **Finish**, which runs the command below. The warning comes at every start until the deployment is finished or forgotten, and it reminds that the resources of a failed deployment must be deleted in the portal.

The connection is saved before the first attach, which makes DuckLake create its tables. aantje marks the lake as not attached when it saves the connection and clears the mark when the attach has succeeded. If the editor closed in between, or the attach failed, the mark is still there at the next start: a warning names the connection and offers **Attach now**, which attaches the lake again with the same data path and clears the mark. The warning comes at every start until then; removing the connection drops the mark.

**aantje: Finish Creating Azure DuckLake...** lists the interrupted deployments. It signs in to the tenant of the lake, waits for the chosen deployment again and, once it has succeeded, saves and attaches the lake with the kept names and password, as Create would have; **Delete Azure DuckLake...** then works for it. If Azure reports the deployment as failed, or does not know it (it never started, or it was deleted), aantje forgets it and says so. Resources that a failed deployment created stay in the resource group and cost money until you delete them in the portal.

By hand: once the deployment has succeeded, open the resource group in the Azure portal, **Deployments**, `aantje-lake-<suffix>`, **Outputs**, copy the value of `ducklake` and run **Import Azure DuckLake...** with it. The generated password is only in the secret storage of aantje, so in the password mode reset the administrator password of the server in the portal first. An imported lake counts as not created by aantje, so **Delete Azure DuckLake...** does not remove its resources.

## Allow My IP

When your address changes (home office, VPN) the connection fails, because the server refuses it. A failed **Connect** that looks like this (the server answers `no pg_hba.conf entry for host`, or does not answer at all) offers the button **Allow my IP**; the command is also in the context menu of an Azure DuckLake, a PostgreSQL connection that has an Azure storage account.

The command:

1. looks up your public IP (above);
2. signs in with the Microsoft account of VS Code, in the tenant of the connection;
3. finds the server: a lake that aantje created is in the record of the editor, any other lake (imported) is found by its host name among the PostgreSQL servers of the subscriptions of that tenant that your account can read;
4. asks you to confirm the address and the server, then replaces the rule `client-ip` with your address and waits until the server shows it.

aantje does not evaluate your permissions itself: Azure decides when the rule is read and written. Writing it needs `Microsoft.DBforPostgreSQL/flexibleServers/firewallRules/write` on the server, which Contributor and Owner have. When Azure refuses (HTTP 403, or the code `AuthorizationFailed` or `LinkedAuthorizationFailed`), the command stops with `Your account may not change the firewall rules of the PostgreSQL server <server>. Ask the owner of the server for a role that allows Microsoft.DBforPostgreSQL/flexibleServers/firewallRules/write, for example Contributor.` Any other refusal shows what Azure said.

Only that one rule is written, and only with a single IPv4 address: aantje refuses `0.0.0.0` (which would admit every Azure service) and any range. Other firewall rules of the server stay as they are, so an address that you added yourself keeps working. If the rule does not exist, it is created. Connect again afterwards; the change can take a minute to reach every gateway.

## Copy Azure Config

**Copy Azure Config** (context menu of an Azure DuckLake) copies the values that the Azure notebooks of the Docker stack read from `notebooks/azure/azure.config.json` ([Docker stack](../../docker/README.md#azure-notebooks)): the storage account, the container `lake` and the folders `data` and `bronze`, the PostgreSQL server, port, database and user, the lake name `azure_lake`, the sign-in `device_code`, `pgAuth` (`entra` for a lake that signs in to PostgreSQL with Microsoft Entra, else `password`) and the tenant of the connection (empty without one). Paste it over the whole file. There is no password in it: the notebook reads it from `OOG_AZURE_PG_PASSWORD` or asks for it. The container and the folder are those of the template of this repository; a lake attached by hand to another container needs them changed in the file. With `pgAuth` `entra` the notebooks use an access token of the same Microsoft sign-in as the password and ask for nothing; the user is your sign-in name.

## Signing in to PostgreSQL

| Mode                | The catalog connection uses                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Password**        | The local administrator `ducklakeadmin` and its generated password in the secret storage. This is the default.          |
| **Microsoft Entra** | Your user principal name and an access token of your Microsoft account as the password. No password is stored anywhere. |

**The default is Password.** Entra is offered in the wizard and in the import, but not preselected, because nothing here has run against a real server yet ([what is not verified](#what-is-verified-and-what-is-not)). Make Entra the default once a test subscription has proven the whole path. The profile field is `azureAuth` (`"entra"`; absent means a password, [Connections](connections.md)).

With Entra the template (`authentication` = `entra`):

- switches on Entra authentication of the server (`authConfig.activeDirectoryAuth` Enabled, with the tenant of the subscription) and keeps `passwordAuth` Enabled, so a local login stays possible as break-glass access. The server needs an administrator password at creation; with Entra aantje generates one and does not keep it, so the break-glass login works only after an owner resets the password of `ducklakeadmin` in the portal. Switching the password login off is a setting of the server in the portal; the template does not do it, to avoid locking everybody out.
- registers you as **Entra administrator** of the server (`flexibleServers/administrators`, named by your object ID, `principalName` your sign-in name). The template cannot look up a name, so aantje passes it: the claim `upn`, else `preferred_username`, of your sign-in token. A portal deployment needs the parameter `principalName` filled in with your user principal name.
- creates that administrator last, after the database, the firewall rule and the TLS setting, because the server runs one operation at a time.

At run time aantje asks VS Code for a token with the scope `https://ossrdbms-aad.database.windows.net/.default` and uses it as the password, with your user principal name as the user:

- the **explorer** gets a new token every time it opens the catalog (Connect, Refresh, the reopening after a lost connection); a token only matters while the connection is made, so an open connection survives the hour;
- the **data engine** (previews, SQL editor, health check) puts the token into the secret `aantje_pg` before the attach, and a long SQL session replaces that secret every ten minutes with a new token from the same sign-in, as it does with the storage token;
- the token is registered with the log redactor and `secretsOf` masks it in engine errors ([Security](security.md)).

An imported lake chooses the mode in the import dialog; a lake whose output says `authentication: "entra"` starts with Entra selected. In Entra mode the user is your own sign-in name, not the user of the output.

**Add Connection** and **Edit Connection** offer the same choice for any PostgreSQL catalog, so a lake that aantje did not create can be added by hand ([Connections](connections.md#signing-in-with-microsoft-entra-id)). With **Microsoft Entra ID** the wizard asks for the tenant (it may stay empty), prefills the user with the sign-in name of your Microsoft account and asks for no password. The storage account of the data files and its sign-in come with the storage questions ([Connections](connections.md#storage)). A password stored for the connection before is deleted. Switching back to **Password** asks for a password again.

### Giving another person access

The Entra administrator is the only Entra login after the deployment. For each further person, connect to the database `postgres` of the server as the administrator (the SQL editor of aantje, `psql` or any client, with a token as the password) and run:

```sql
select * from pgaadauth_create_principal('grace@contoso.com', false, false);
GRANT USAGE ON SCHEMA public TO "grace@contoso.com";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "grace@contoso.com";
```

The first statement creates the role for the Entra user (`false, false`: not an administrator, no MFA flag); the grants allow reading the catalog. A person who writes needs `INSERT`, `UPDATE` and `DELETE` on the tables, and `CREATE` on the schema for a first attach. The person also needs a data role on the storage account ([Reading and writing the data files](#reading-and-writing-the-data-files)). Then they run **Add Connection** with **Microsoft Entra ID** and the storage account, or import the lake and choose Entra.

## Reading and writing the data files

An Azure lake connection has a `storage` of kind `azure` (`{ "kind": "azure", "account": "<account>", "tenant": "<tenant>", "signIn": "entra" }`): the storage account and the way aantje signs in to it. **Create**, **Finish Creating** and **Import** write it; Add Connection and Edit Connection ask for it ([Connections](connections.md#storage)). `azureAuth` and `azureTenant` stay: they describe the sign-in to PostgreSQL. A connection that was saved before with `azureAccount` and `azureTenant` keeps working; it is read as `storage` with `signIn` `entra`, and nothing rewrites it. The explorer needs none of this; it reads the catalog from PostgreSQL. The data engine (Select Top 1000 Rows, the SQL editor, health check) then:

1. installs and loads the DuckDB `azure` extension with `ducklake`, `postgres` and `httpfs` before the attach; on Linux it sets `azure_transport_option_type` to `curl`, because the default transport finds the CA certificates only at the Red Hat path `/etc/pki/tls/certs/ca-bundle.crt` and fails on Debian and Ubuntu with `Problem with the SSL CA cert`;
2. creates the storage secret (`aantje_storage`; `aantje_azure` for the legacy form) with `TYPE azure`, `PROVIDER access_token`, the account name and an Entra token for the scope `https://storage.azure.com/.default`;
3. attaches the lake as for any other PostgreSQL catalog.

Microsoft Entra with the account of VS Code is the sign-in that Create and Import choose, because the template turns shared key access off. For a lake that you attach by hand, or whose storage you reach differently, `signIn` can also be a connection string, an account key, a SAS token, a service principal (client secret or certificate) or the credential chain (Azure CLI, managed identity, environment); the secrets go to the secret storage, never to the settings ([Data access](data-access.md#storage-of-a-connection)). Account key and SAS token need shared key access on the account, which the template of this repository switches off. The same `storage` can sit on a SQLite or DuckDB catalog, and `kind` `onelake` points a connection at Microsoft Fabric OneLake.

The Entra token is a request to VS Code (`vscode.authentication.getSession('microsoft', ...)`), never stored by aantje. The `azure` extension does not renew an `access_token`, so a long SQL session replaces the secret every ten minutes with a new token from the same sign-in; a failed renewal is logged and the session goes on with the old token until it runs out. A data preview opens a new engine for each read and so gets a fresh token each time.

**The secret has no scope.** An unscoped Azure secret matches every `abfss://`, `az://` and `azure://` path, and DuckDB then contacts the host that is in the path. The guard refuses files that a catalog names on hosts other than the storage account ([Security](security.md#azure-storage-and-the-unscoped-secret)); the SQL editor runs your own SQL and has no guard.

**Hardening.** The engine switches `autoinstall_known_extensions` and `autoload_known_extensions` off after the attach, and `allow_persistent_secrets` is off for the whole instance. `azure` is installed and loaded before that, like `httpfs`, so no allow-list entry is needed, and the token exists only in the memory of the engine. A machine without internet needs `azure` in `aantje.duckdb.extensionDirectory` too (`httpfs` as well, and `aws` for an S3 connection with the credential chain). The token is registered with the log redactor and `secretsOf` masks it in engine errors ([Security](security.md)).

## Importing a portal deployment

The deployment outputs a string `ducklake` with a ready `ATTACH` statement, the Azure secret settings and the host, database and user of the catalog. It never holds the password, because everyone who can read the deployment can read its outputs. **Import Azure DuckLake...** takes this JSON from the clipboard or a box, asks for a connection name and the sign-in mode, and for the password in the password mode. It tests the connection and saves it with `storage` (`kind` `azure`, the storage account of the output, `signIn` `entra`). In Entra mode the output says that an access token is the password and for which scope; it holds the name of the deployer as the user. The Microsoft account of VS Code needs a data role on the storage account: the template gives it to the `principalId` that was entered. An imported lake has no tenant; set it with Edit Connection if you work in several tenants.

## Deleting a lake

**Delete Azure DuckLake...** is in the context menu of an Azure DuckLake, not in the toolbar, and works only for lakes that aantje created; for an imported lake it says that it cannot delete resources it did not create (the resource names are kept in the global state of the editor). It asks for the name of the lake to be typed, then for a second confirmation that says the data cannot be restored. It signs in to the tenant of the lake, then:

- deletes the **resource group** only if this lake's creation made the group and it holds nothing but the server and the storage account now;
- otherwise deletes only the **PostgreSQL server and the storage account**, by their resource ids.

The connection and its password are removed afterwards. Azure finishes the deletion in the background: aantje follows the address that Azure returns with each accepted delete (`Azure-AsyncOperation`, else `Location`, and only on `management.azure.com`) every 15 seconds for up to an hour (after a failed poll twice as long, as while waiting for a deployment), without holding the command. The end goes to the output; a failure also shows as an error, because what is not deleted keeps costing money.

## What the output shows

The output channel **aantje** logs every step of the Azure commands, so that a run can be followed after the progress notification has gone:

| Level   | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `info`  | **Create** and **Finish Creating**: the choices (subscription with name and id, new or existing resource group, region, size, sign-in), the signed-in object id and tenant, the checks with the names of server and storage account, the public IP of the firewall rule, the resource group created, the start of the deployment with a link to it in the Azure portal, each change of its state, each resource of the template when it has ended (type, name, state, duration), the end with its duration and correlation id, the saved connection (host, database, user, storage account, data path) and the first attach |
| `info`  | **Delete**: the lake, what its resource group holds and why the whole group or only the server and the storage account are deleted, each accepted DELETE, the removed connection, and when Azure has finished each delete                                                                                                                                                                                                                                                                                                                                                                                                   |
| `info`  | **Import** and **Allow My IP**: the read output, the result of the connection test; the IP, the server and whether the rule was created, updated or unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `info`  | **Explorer**: after a failed connect to an Azure DuckLake without DuckLake tables (`NOT_A_DUCKLAKE`), what to do: wait until the creation reports the lake as created and refresh, or run **Finish Creating Azure DuckLake...** for an interrupted creation                                                                                                                                                                                                                                                                                                                                                                 |
| `warn`  | A poll that Azure did not answer and that is tried again, the storage role that has not taken effect yet, a resource of the template that failed                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `error` | A failed command, a failed first attach, a delete that Azure did not finish                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `debug` | Every request to Azure Resource Manager: method, path, status, duration and correlation id. Shown after **Developer: Set Log Level...** (or the gear of the channel) is set to Debug                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Never logged: the generated administrator password, any token, and the template parameters as sent (they hold the password). The tokens and the kept password are registered with the redactor too ([Security](security.md)), and a unit test checks that a whole create run logs neither the password nor the token. The import registers the typed password before its connection test, so a failed test logs it masked.

## What is verified, and what is not

Nothing in this feature has run against a real Azure subscription.

**Checked without Azure:** the Bicep file compiles and lints clean (`az bicep build`, `az bicep lint`), the committed `azuredeploy.json` equals a fresh build (`npm run check:azure-template`), and the parameters, SKUs and security settings of the template are pinned by unit tests. The ARM client, Azure's check before the deployment, the deployment polling, the error mapping, the delete rules, the wizards, the token claims, the password, the retry and the DuckDB statements are covered by unit tests with mocks.

**Not verified; these questions are open:**

- Whether the Microsoft client of VS Code hands out a token for `https://ossrdbms-aad.database.windows.net/` without a further consent, also with several tenants.
- The Entra setup: the shape and API version (`2024-08-01`) of `flexibleServers/administrators`, whether `authConfig` with the tenant and the administrator can be set in one deployment without a race (the template orders it last), and that `principalName` as the sign-in name is what the server expects.
- That the Node driver of the explorer and the `postgres` extension of DuckDB accept the token as the password, with TLS `verify-full` and the system roots; and whether replacing the secret `aantje_pg` in a long session reaches connections that DuckDB opens later (the attach itself keeps the connection string it was given). If it does not, a session can need a new attach after about an hour.
- `pgaadauth_create_principal` and the grants of the section above.
- Allow My IP: the API of `flexibleServers/firewallRules` (the PUT is a long-running operation; aantje waits by reading the rule back), the server lookup by `fullyQualifiedDomainName`, the code with which Azure refuses a rule to an account without the permission, and the text of the refusal that the blocked-IP hint matches (`no pg_hba.conf entry`).
- Azure's check before the deployment: whether `.../validate` answers at once or with 202, and the shape of its refusal when a permission is missing (the role assignment, or the deployment itself), which aantje reads as described [above](#azures-check-before-the-deployment).

- Whether the Microsoft client of VS Code hands out tokens for `https://management.azure.com/` and `https://storage.azure.com/` without a further consent, also with several tenants and the `VSCODE_TENANT:<id>` scope.
- Whether DuckDB can read and write ADLS through a long session with an `access_token` secret, how often it must be replaced, and whether `credential_chain` is the better default.
- Which regions offer the SKUs and ZRS together with hierarchical namespace. The region hint reads the SKU lists of the Microsoft.Storage and Microsoft.DBforPostgreSQL providers and does not check the combination with hierarchical namespace.
- How long a new role assignment needs to take effect; the retry (about four minutes in total) is a guess.
- Whether the DuckDB `azure` extension loads under the hardened engine settings on every platform, and that listing the container with `glob` is allowed by the Storage Blob Data Contributor role as expected.
- Whether the certificate of an Azure PostgreSQL server is accepted by the TLS check of the explorer (Node.js trust store) and of DuckDB (`verify-full` with the system roots). If a root certificate is missing, set `NODE_EXTRA_CA_CERTS`.
- The ARM request and response shapes are written from the documented REST APIs; the API versions are in `src/azure/arm-transport.ts`.

Before a release, run the wizard once in a test subscription and delete the lake again.
