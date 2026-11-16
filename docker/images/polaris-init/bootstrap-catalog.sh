#!/bin/sh
# Create the Iceberg catalog in Polaris and let the root principal manage it (idempotent).
# One-shot init for Docker Compose (service polaris-init). Runs in the Polaris image, which has curl.
#
# Environment:
#   OOG_POLARIS_URL            Polaris API                                (default http://polaris:8181)
#   OOG_POLARIS_CLIENT_ID      principal that was bootstrapped            (default root)
#   OOG_POLARIS_CLIENT_SECRET  its secret                                 (required, secret)
#   OOG_POLARIS_CATALOG        catalog to create                          (default oog_iceberg)
#   OOG_ICEBERG_BUCKET         bucket of the catalog                      (default oog-iceberg)
#   OOG_S3_ENDPOINT            S3 endpoint, as seen by Polaris and clients (default http://rustfs:9000)
#   OOG_BOOTSTRAP_TIMEOUT      stop waiting for Polaris after this many seconds (default 120)
#
# Exit status: 0 the catalog exists and root manages it, 1 failed, 2 invalid configuration.
set -eu

url=${OOG_POLARIS_URL:-http://polaris:8181}
id=${OOG_POLARIS_CLIENT_ID:-root}
catalog=${OOG_POLARIS_CATALOG:-oog_iceberg}
bucket=${OOG_ICEBERG_BUCKET:-oog-iceberg}
endpoint=${OOG_S3_ENDPOINT:-http://rustfs:9000}
timeout=${OOG_BOOTSTRAP_TIMEOUT:-120}
[ -n "${OOG_POLARIS_CLIENT_SECRET:-}" ] || { echo "[polaris-init] ERROR: OOG_POLARIS_CLIENT_SECRET is not set" >&2; exit 2; }

log() { printf '[polaris-init] %s\n' "$*"; }

# The client secret goes to curl through stdin (--data-urlencode name@-), never into a command line.
token=
waited=0
while [ -z "$token" ]; do
  token=$(printf '%s' "$OOG_POLARIS_CLIENT_SECRET" | curl -fsS -X POST "$url/api/catalog/v1/oauth/tokens" \
    --data-urlencode grant_type=client_credentials --data-urlencode "client_id=$id" \
    --data-urlencode "client_secret@-" --data-urlencode scope=PRINCIPAL_ROLE:ALL 2>/dev/null \
    | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p') || true
  if [ -z "$token" ]; then
    [ "$waited" -lt "$timeout" ] || { echo "[polaris-init] ERROR: no token from $url after ${timeout}s" >&2; exit 1; }
    sleep 2; waited=$((waited + 2))
  fi
done
log "signed in as $id"

api() { # method path [json]
  if [ $# -ge 3 ]; then
    curl -sS -o /dev/null -w '%{http_code}' -X "$1" "$url/api/management/v1$2" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$3"
  else
    curl -sS -o /dev/null -w '%{http_code}' -X "$1" "$url/api/management/v1$2" -H "Authorization: Bearer $token"
  fi
}

location="s3://$bucket/warehouse"
code=$(api POST /catalogs "{\"catalog\":{\"name\":\"$catalog\",\"type\":\"INTERNAL\",\"readOnly\":false,\"properties\":{\"default-base-location\":\"$location\"},\"storageConfigInfo\":{\"storageType\":\"S3\",\"allowedLocations\":[\"$location\"],\"endpoint\":\"$endpoint\",\"endpointInternal\":\"$endpoint\",\"pathStyleAccess\":true,\"roleArn\":\"arn:aws:iam::000000000000:role/polaris\"}}}")
case $code in
  201) log "catalog $catalog created (data in $location)" ;;
  409) log "catalog $catalog exists" ;;
  *) echo "[polaris-init] ERROR: creating the catalog answered HTTP $code" >&2; exit 1 ;;
esac

code=$(api PUT "/catalogs/$catalog/catalog-roles/catalog_admin/grants" '{"grant":{"type":"catalog","privilege":"CATALOG_MANAGE_CONTENT"}}')
[ "$code" = 201 ] || [ "$code" = 200 ] || { echo "[polaris-init] ERROR: the grant answered HTTP $code" >&2; exit 1; }
code=$(api PUT "/principal-roles/service_admin/catalog-roles/$catalog" '{"catalogRole":{"name":"catalog_admin"}}')
[ "$code" = 201 ] || [ "$code" = 200 ] || { echo "[polaris-init] ERROR: assigning the role answered HTTP $code" >&2; exit 1; }
log "done: $id manages $catalog"
