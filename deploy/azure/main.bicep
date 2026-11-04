// A DuckLake on Azure: PostgreSQL flexible server (catalog) and an ADLS Gen2 storage account (data files).
// The single source of truth; `npm run build:azure-template` compiles it to azuredeploy.json.
targetScope = 'resourceGroup'

@description('Short prefix of the resource names: 3 to 11 lowercase letters, digits or hyphens, starting with a letter and not ending with a hyphen.')
@minLength(3)
@maxLength(11)
param namePrefix string

@description('Small: Burstable server, 32 GiB, locally redundant storage. Medium: General Purpose server, 128 GiB, zone-redundant storage.')
@allowed(['small', 'medium'])
param size string = 'small'

@description('Object ID of the user (or service principal) that reads and writes the data files. It gets Storage Blob Data Contributor on the storage account.')
param principalId string

@description('Type of the principal.')
@allowed(['User', 'ServicePrincipal', 'Group'])
param principalType string = 'User'

@description('Public IPv4 address that may connect to the PostgreSQL server. No other address is allowed.')
param clientIp string

@description('password: the local administrator login only. entra: Microsoft Entra authentication too, with the principal below as Entra administrator; the local login stays enabled as break-glass access.')
@allowed(['password', 'entra'])
param authentication string = 'password'

@description('User principal name (or display name) of the principal; the Entra administrator is registered under it. Needed for authentication entra, ignored otherwise.')
param principalName string = ''

@description('Password of the PostgreSQL administrator. It is never part of the outputs.')
@secure()
param administratorLoginPassword string

@description('Location of all resources. Leave it empty to use the location of the resource group.')
param location string = ''

@description('Major version of PostgreSQL. aantje passes the newest one that the region offers.')
param postgresVersion string = '17'

@description('Makes the resource names unique: by default the first 13 hex digits of a new GUID, so every deployment creates a new lake. Leave the default unless a caller needs to know the names in advance.')
@minLength(8)
// A GUID without hyphens has 32 characters, so the default always has 13.
#disable-next-line BCP334
param uniqueSuffix string = take(replace(newGuid(), '-', ''), 13)

var sizes = {
  small: {
    serverSku: 'Standard_B1ms'
    serverTier: 'Burstable'
    storageSizeGB: 32
    storageSku: 'Standard_LRS'
  }
  medium: {
    serverSku: 'Standard_D2ds_v5'
    serverTier: 'GeneralPurpose'
    storageSizeGB: 128
    storageSku: 'Standard_ZRS'
  }
}
var preset = sizes[size]

var entra = authentication == 'entra'
var administratorLogin = 'ducklakeadmin'
// The login that aantje and DuckDB use: the Entra administrator, or the local administrator.
var catalogUser = entra ? principalName : administratorLogin
var databaseName = 'ducklake_catalog'
var containerName = 'lake'
var serverName = '${namePrefix}-${take(uniqueSuffix, 13)}-pg'
// 3 to 24 lowercase letters and digits: at most 11 from the prefix and 13 from the suffix.
var storageAccountName = take('${replace(namePrefix, '-', '')}${uniqueSuffix}', 24)
var resourceLocation = empty(location) ? resourceGroup().location : location

var storageBlobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  // New names for every deployment are the point: each one creates a new lake.
  #disable-next-line use-stable-resource-identifiers
  name: serverName
  location: resourceLocation
  sku: {
    name: preset.serverSku
    tier: preset.serverTier
  }
  properties: {
    version: postgresVersion
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorLoginPassword
    storage: {
      storageSizeGB: preset.storageSizeGB
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    authConfig: {
      activeDirectoryAuth: entra ? 'Enabled' : 'Disabled'
      passwordAuth: 'Enabled'
      tenantId: entra ? subscription().tenantId : null
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

// The operations on one server run one after the other; without the dependencies ARM answers with "server is busy".
resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource firewallRule 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: server
  name: 'client-ip'
  properties: {
    startIpAddress: clientIp
    endIpAddress: clientIp
  }
  dependsOn: [database]
}

resource requireTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'require_secure_transport'
  properties: {
    value: 'on'
    source: 'user-override'
  }
  dependsOn: [firewallRule]
}

// The server must finish the other operations first, so this one comes last.
resource entraAdministrator 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = if (entra) {
  parent: server
  name: principalId
  properties: {
    principalType: principalType
    principalName: principalName
    tenantId: subscription().tenantId
  }
  dependsOn: [requireTls]
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  #disable-next-line use-stable-resource-identifiers
  name: storageAccountName
  location: resourceLocation
  kind: 'StorageV2'
  sku: {
    name: preset.storageSku
  }
  properties: {
    isHnsEnabled: true
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    defaultToOAuthAuthentication: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: containerName
}

resource dataAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, principalId, storageBlobDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributor)
    principalId: principalId
    principalType: principalType
  }
}

var catalogHost = server.properties.fullyQualifiedDomainName
// The scope of the token that Azure Database for PostgreSQL accepts as the password.
var postgresScope = 'https://ossrdbms-aad${environment().suffixes.sqlServerHostname}/.default'

@description('Everything aantje needs to connect, as JSON. It never contains the password. With authentication entra it says that an access token is the password.')
output ducklake string = string(union({
  authentication: authentication
  attach: 'ATTACH \'ducklake:postgres:dbname=${databaseName} host=${catalogHost} sslmode=verify-full sslrootcert=system user=${catalogUser}\' AS lake (DATA_PATH \'abfss://${containerName}@${storage.name}.dfs.${environment().suffixes.storage}/data/\');'
  azureSecret: {
    provider: 'access_token'
    accountName: storage.name
  }
  postgres: {
    host: catalogHost
    database: databaseName
    user: catalogUser
    port: 5432
  }
}, entra ? {
  entraToken: {
    scope: postgresScope
    use: 'Pass an access token for this scope as the PostgreSQL password; it expires after about an hour.'
  }
} : {}))

output postgresHost string = catalogHost
output postgresServerName string = server.name
output storageAccountName string = storage.name
