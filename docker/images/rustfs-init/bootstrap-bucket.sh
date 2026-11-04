#!/bin/sh
# Create the S3 buckets in RustFS (idempotent) once RustFS answers.
# One-shot init for Docker Compose (service rustfs-init) and the Kubernetes Job.
#
# Environment (see docs/conventions.md):
#   OOG_S3_ENDPOINT       RustFS S3 endpoint                       (default http://rustfs:9000)
#   OOG_S3_REGION         signing region                           (default us-east-1)
#   OOG_S3_BUCKET         bucket to create                         (default oog-lake)
#   OOG_S3_EXTRA_BUCKETS  more buckets to create, comma-separated  (optional, e.g. oog-gitea)
#   OOG_S3_ACCESS_KEY     access key                               (required, secret)
#   OOG_S3_SECRET_KEY     secret key                               (required, secret)
# Optional tuning:
#   OOG_BOOTSTRAP_TIMEOUT   stop retrying after this many seconds, one limit for all buckets (default 120)
#   OOG_BOOTSTRAP_INTERVAL  pause between attempts in seconds                                (default 2)
#
# Buckets are handled one after the other: OOG_S3_BUCKET first, then the extra ones in the given order.
# Blanks around a name and empty entries are ignored; a repeated name, or one equal to OOG_S3_BUCKET,
# is handled once. Every name must be a valid S3 bucket name (3 to 63 characters: a-z, 0-9, "-" and ".";
# starts and ends with a letter or digit; no ".."), otherwise the script stops before it contacts RustFS.
#
# Exit status: 0 all buckets exist, 1 a bucket is not available (timeout, rejected), 2 invalid configuration.
# Path-style addressing comes from AWS_CONFIG_FILE, which the Dockerfile points to.
set -eu

log()  { printf '[rustfs-init] %s\n' "$*"; }
warn() { printf '[rustfs-init] %s\n' "$*" >&2; }
die()  { code=$1; shift; warn "ERROR: $*"; exit "$code"; }

trap 'warn "interrupted"; exit 143' INT TERM

is_uint() {
  case $1 in ''|*[!0-9]*) return 1 ;; esac
  [ "${#1}" -le 9 ]
}

# Decimal value without leading zeros: $(( )) reads 010 as octal (8) and fails on 08 and 09.
dec() { _n=${1#"${1%%[!0]*}"}; printf '%s' "${_n:-0}"; }

# S3 bucket name: 3 to 63 characters of a-z, 0-9, "-" and "."; starts and ends with a letter or digit; no "..".
valid_bucket() {
  case $1 in ''|[!a-z0-9]*|*[!a-z0-9]|*[!a-z0-9.-]*|*..*) return 1 ;; esac
  [ "${#1}" -ge 3 ] && [ "${#1}" -le 63 ]
}

# add_bucket <name> <variable it came from>: check the name and append it to $buckets unless it is there already.
add_bucket() {
  valid_bucket "$1" ||
    die 2 "invalid bucket name '$1' in $2 (3 to 63 characters: a-z, 0-9, - and .; start and end with a letter or digit; no '..')"
  case " $buckets " in *" $1 "*) return 0 ;; esac
  buckets=${buckets:+$buckets }$1
}

endpoint=${OOG_S3_ENDPOINT:-http://rustfs:9000}
region=${OOG_S3_REGION:-us-east-1}
timeout=${OOG_BOOTSTRAP_TIMEOUT:-120}
interval=${OOG_BOOTSTRAP_INTERVAL:-2}

[ -n "${OOG_S3_ACCESS_KEY:-}" ] || die 2 "OOG_S3_ACCESS_KEY is not set"
[ -n "${OOG_S3_SECRET_KEY:-}" ] || die 2 "OOG_S3_SECRET_KEY is not set"
case $endpoint in
  http://*|https://*) ;;
  *) die 2 "OOG_S3_ENDPOINT must start with http:// or https:// (got '$endpoint')" ;;
esac
is_uint "$timeout" || die 2 "OOG_BOOTSTRAP_TIMEOUT must be a whole number of seconds (got '$timeout')"
is_uint "$interval" || die 2 "OOG_BOOTSTRAP_INTERVAL must be a whole number of seconds (got '$interval')"
timeout=$(dec "$timeout")
interval=$(dec "$interval")
[ "$interval" -ge 1 ] || die 2 "OOG_BOOTSTRAP_INTERVAL must be at least 1"

# The buckets in the order they are handled: OOG_S3_BUCKET, then the comma-separated extras.
buckets=''
add_bucket "${OOG_S3_BUCKET:-oog-lake}" OOG_S3_BUCKET
rest=${OOG_S3_EXTRA_BUCKETS:-}
while [ -n "$rest" ]; do
  case $rest in
    *,*) name=${rest%%,*}; rest=${rest#*,} ;;
    *)   name=$rest; rest='' ;;
  esac
  name=${name#"${name%%[![:space:]]*}"}  # trim blanks
  name=${name%"${name##*[![:space:]]}"}
  [ -z "$name" ] || add_bucket "$name" OOG_S3_EXTRA_BUCKETS
done

export AWS_ACCESS_KEY_ID="$OOG_S3_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$OOG_S3_SECRET_KEY"
export AWS_DEFAULT_REGION="$region"
export AWS_EC2_METADATA_DISABLED=true  # static credentials only, never ask IMDS
export AWS_MAX_ATTEMPTS=1              # retrying is done by the loop below
export AWS_PAGER=

s3api() {
  aws --endpoint-url "$endpoint" --cli-connect-timeout 5 --cli-read-timeout 15 s3api "$@"
}

create_bucket() {
  if [ "$region" = us-east-1 ]; then
    s3api create-bucket --bucket "$bucket"
  else
    s3api create-bucket --bucket "$bucket" --create-bucket-configuration "LocationConstraint=$region"
  fi
}

# First lines of an AWS CLI error as one short line, without the "aws: [ERROR]: " prefix.
oneline() {
  printf '%s\n' "$1" | sed -e '/^[[:space:]]*$/d' -e 's/^aws: [[]ERROR[]]: //' -e 's/ (reached max retries: [0-9]*)//' |
    awk 'NR <= 2 { printf "%s%s", (NR > 1 ? " " : ""), $0 }' | cut -c1-400
}

# Try to make sure the bucket exists. Return 0 if it does ($result says how),
# 1 if that is not possible yet and 2 if it never will be; $err holds the reason.
ensure_bucket() {
  if out=$(s3api head-bucket --bucket "$bucket" 2>&1); then
    result='already exists'
    return 0
  fi
  case $out in
    *'Could not connect'*|*'Connect timeout'*|*'Read timeout'*) err=$out; return 1 ;;  # RustFS not reachable yet
  esac
  # RustFS answered (404: bucket is missing; otherwise create-bucket reports the exact reason).
  if out=$(create_bucket 2>&1); then
    result=created
  else
    case $out in
      *BucketAlreadyOwnedByYou*) result='already exists' ;;  # created concurrently
      *InvalidBucketName*|*ParamValidation*) err=$out; return 2 ;;
      *) err=$out; return 1 ;;
    esac
  fi
  if out=$(s3api head-bucket --bucket "$bucket" 2>&1); then  # final proof
    return 0
  fi
  err=$out
  return 1
}

give_up() {
  warn "ERROR: bucket '$bucket' is not available at $endpoint after ${1}s"
  warn "Last error: $(oneline "$err")"
  [ -z "$todo" ] || warn "Not attempted: $todo"
  case $err in
    *InvalidAccessKeyId*|*SignatureDoesNotMatch*|*AccessDenied*|*'(403)'*)
      warn "Hint: RustFS rejected the credentials; OOG_S3_ACCESS_KEY / OOG_S3_SECRET_KEY must match RUSTFS_ACCESS_KEY / RUSTFS_SECRET_KEY of the rustfs service." ;;
    *'Could not connect'*|*'Connect timeout'*|*'Read timeout'*)
      warn "Hint: RustFS is not reachable; check that the rustfs service is running and that OOG_S3_ENDPOINT is correct." ;;
    *'File access denied'*|*'Permission denied'*)
      warn "Hint: RustFS cannot write to its data directory; /data must be writable by UID/GID 10001 (RustFS runs as that user)." ;;
  esac
  exit 1
}

start=$(date +%s)
err=''
result=''
bucket=''
todo=$buckets  # buckets still to be handled, the current one excluded

# Make sure $bucket exists. All buckets share one deadline ($timeout seconds after $start); a bucket that
# comes after a slow one still gets one attempt.
wait_for_bucket() {
  last_msg=''
  last_log=-100
  while :; do
    rc=0
    ensure_bucket || rc=$?
    elapsed=$(( $(date +%s) - start ))
    case $rc in
      0) log "bucket '$bucket' $result (${elapsed}s)"; return 0 ;;
      2) warn "ERROR: bucket '$bucket' cannot be created: $(oneline "$err")"; exit 1 ;;
    esac
    left=$(( timeout - elapsed ))
    [ "$left" -gt 0 ] || give_up "$elapsed"
    msg=$(oneline "$err")
    if [ "$msg" != "$last_msg" ] || [ $(( elapsed - last_log )) -ge 10 ]; then
      log "waiting for bucket '$bucket' (${elapsed}s/${timeout}s): $msg"
      last_msg=$msg
      last_log=$elapsed
    fi
    if [ "$left" -lt "$interval" ]; then sleep "$left"; else sleep "$interval"; fi
  done
}

log "ensuring bucket(s) at $endpoint (region $region, timeout ${timeout}s): $buckets"
while [ -n "$todo" ]; do
  bucket=${todo%% *}
  case $todo in *' '*) todo=${todo#* } ;; *) todo='' ;; esac
  wait_for_bucket
done
log "done"
