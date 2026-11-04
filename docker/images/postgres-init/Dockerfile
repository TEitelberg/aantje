# One-shot init image: creates the databases and login roles of the Oog tools on the shared
# Postgres server (idempotent). The Postgres base image only supplies psql and pg_isready; its
# server is never started here.
# Build context is the repository root:
#   docker build -f images/postgres-init/Dockerfile -t oog/postgres-init:0.1.0 .
# The psql in the base image must be version 15 or newer (the script reads secrets with \getenv).
# The base image declares VOLUME /var/lib/postgresql/data (Postgres 18+: /var/lib/postgresql), so every
# container started from this image gets an anonymous volume that "docker compose down" leaves behind.
# Mount a tmpfs on that path to avoid it (Compose: tmpfs: [/var/lib/postgresql/data]; for Postgres 18+
# it must be /var/lib/postgresql, and listing both paths works for every version).
ARG POSTGRES_VERSION=17-alpine
FROM postgres:${POSTGRES_VERSION}

LABEL org.opencontainers.image.title="oog-postgres-init" \
      org.opencontainers.image.description="One-shot job that creates the databases and roles of the Oog tools on the shared Postgres server"

COPY --chmod=755 images/postgres-init/init-databases.sh /init-databases.sh

# Numeric id of "nobody" (present in the Alpine and the Debian variants): satisfies runAsNonRoot in Kubernetes.
USER 65534:65534
# Replaces the server entrypoint of the base image (Docker also drops the inherited CMD ["postgres"]).
ENTRYPOINT ["/bin/sh", "/init-databases.sh"]
