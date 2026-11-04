# One-shot init image: creates the Gitea administrator (idempotent) and keeps its password in line with
# the configuration. It is the Gitea image plus a script, because the gitea CLI needs the same
# binary, database driver and app.ini as the server.
# Build context is the repository root:
#   docker build -f images/gitea-init/Dockerfile -t oog/gitea-init:0.1.0 .
# The base image keeps its ENTRYPOINT: docker-setup.sh renders /etc/gitea/app.ini from the GITEA__* variables,
# then runs the CMD. Therefore pass a replacement as "command:" in Compose and "args:" in Kubernetes, never
# as Kubernetes "command:" (that would replace the entrypoint and skip the app.ini).
# The base image declares VOLUME /etc/gitea and VOLUME /var/lib/gitea, so every container started from this
# image gets two anonymous volumes that "docker compose down" leaves behind. Mount a tmpfs on both paths to
# avoid that (Compose: tmpfs: ["/etc/gitea:uid=1000,gid=1000,mode=0700", "/var/lib/gitea:uid=1000,gid=1000,mode=0700"];
# the uid/gid are required, otherwise the entrypoint stops with "/etc/gitea is not writable"; Kubernetes: emptyDir).
ARG GITEA_VERSION=28.2.0
FROM docker.gitea.com/gitea:${GITEA_VERSION}-rootless

LABEL org.opencontainers.image.title="oog-gitea-init" \
      org.opencontainers.image.description="One-shot job that creates the Gitea administrator and synchronises its password"

COPY --chmod=755 images/gitea-init/init-admin.sh /usr/local/bin/oog-gitea-init
COPY --chmod=755 images/gitea-init/create-workspace-repo.sh /usr/local/bin/oog-gitea-workspace
# First commit of the workspace repository: notebooks/ (the example notebooks in local/, quack/ and azure/; the .dockerignore lets only the
# shipped files through) and the files of the repository root (workspace/: README, .gitignore). The workbench image carries the same seed.
COPY notebooks/ /opt/oog/workspace-seed/notebooks/
COPY workspace/ /opt/oog/workspace-seed/

# Numeric id of "git" in the base image: satisfies runAsNonRoot in Kubernetes.
USER 1000:1000
CMD ["/bin/sh", "/usr/local/bin/oog-gitea-init"]
