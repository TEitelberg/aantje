# An Azure DuckLake from one template

`main.bicep` creates what a DuckLake needs in Azure:

- an Azure Database for PostgreSQL flexible server with the database `ducklake_catalog` (the catalog), reachable from one public IP address only, TLS required;
- a storage account with hierarchical namespace (ADLS Gen2) and the container `lake` (the data files), without shared key access;
- the role **Storage Blob Data Contributor** on the storage account for the user or service principal that you name.

DuckLake creates its tables in the catalog on the first `ATTACH`, so nothing needs to run after the deployment. `azuredeploy.json` is compiled from `main.bicep` (`npm run build:azure-template`); edit the Bicep file, not the JSON.

aantje uses the same template when you run **aantje: Create Azure DuckLake...** in VS Code. The button below is for the portal or for a pipeline.

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FTEitelberg%2Faantje%2Fmain%2Fdeploy%2Fazure%2Fazuredeploy.json)

The button opens the template that is on the `main` branch of the repository.

## Parameters

| Parameter                    | What to enter                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `namePrefix`                 | 3 to 11 lowercase letters, digits or hyphens, starting with a letter. The names of the resources start with it.                                                                                        |
| `size`                       | `small` (Burstable `Standard_B1ms`, 32 GiB, locally redundant storage) or `medium` (General Purpose `Standard_D2ds_v5`, 128 GiB, zone-redundant storage).                                              |
| `principalId`                | The object ID of the user who works with the lake: `az ad signed-in-user show --query id -o tsv`. This identity gets the storage role.                                                                 |
| `authentication`             | `password` (default) or `entra`. With `entra` the server also accepts Microsoft Entra sign-ins and the principal becomes its Entra administrator; the local login stays enabled as break-glass access. |
| `principalName`              | Needed for `entra`: the user principal name of the principal, for example `ada@contoso.com`.                                                                                                           |
| `clientIp`                   | Your public IPv4 address. Only this address may connect to PostgreSQL. Change the firewall rule on the server when your address changes.                                                               |
| `administratorLoginPassword` | A password for the PostgreSQL administrator `ducklakeadmin`. Keep it: you need it to import the connection.                                                                                            |

`principalType` (default `User`), `location` (default: empty, which means the location of the resource group) and `uniqueSuffix` (default: the first 13 hex digits of a new GUID, so every deployment creates a new lake with new names in the resource group) rarely need a value. Deploying the template needs Owner or User Access Administrator on the resource group, because it creates a role assignment.

## Import the result into aantje

1. Open the finished deployment in the portal, choose **Outputs** and copy the value of `ducklake`.
2. Run **aantje: Import Azure DuckLake...**. aantje offers the JSON on the clipboard, or you paste it into the box.
3. Enter a name and the password of the administrator. aantje tests the connection and saves it.

The output looks like this and never holds the password:

```json
{
  "attach": "ATTACH 'ducklake:postgres:dbname=ducklake_catalog host=<server>.postgres.database.azure.com sslmode=verify-full sslrootcert=system user=ducklakeadmin' AS lake (DATA_PATH 'abfss://lake@<account>.dfs.core.windows.net/data/');",
  "azureSecret": { "provider": "access_token", "accountName": "<account>" },
  "postgres": {
    "host": "<server>.postgres.database.azure.com",
    "database": "ducklake_catalog",
    "user": "ducklakeadmin",
    "port": 5432
  }
}
```

With `authentication` `entra` the output also has `"entraToken": { "scope": "https://ossrdbms-aad.database.windows.net/.default", "use": "..." }`, the user is the `principalName`, and there is no password at all: an access token for that scope is the password.

The `attach` statement is for DuckDB itself. Add the password with `PASSWORD '...'` in the connection string or a PostgreSQL secret, and an Azure secret for the storage account (`TYPE azure`, `PROVIDER access_token` or `credential_chain`).

The lake is not managed by aantje when it comes from the portal: **Delete Azure DuckLake...** works only for lakes that aantje created. Delete the resources in the portal.
