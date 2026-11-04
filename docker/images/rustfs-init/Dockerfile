# One-shot init image: creates the S3 buckets in RustFS (idempotent).
# Build context is the repository root:
#   docker build -f images/rustfs-init/Dockerfile -t oog/rustfs-init:0.1.0 .
ARG AWS_CLI_VERSION=2.39.2
FROM amazon/aws-cli:${AWS_CLI_VERSION}

LABEL org.opencontainers.image.title="oog-rustfs-init" \
      org.opencontainers.image.description="One-shot job that creates the S3 buckets in RustFS"

# RustFS is addressed path-style (http://rustfs:9000/<bucket>); there is no bucket.rustfs DNS name.
RUN mkdir -p /etc/oog \
 && printf '[default]\ns3 =\n    addressing_style = path\n' > /etc/oog/aws-config
ENV AWS_CONFIG_FILE=/etc/oog/aws-config \
    AWS_EC2_METADATA_DISABLED=true

COPY --chmod=755 images/rustfs-init/bootstrap-bucket.sh /bootstrap-bucket.sh

# Nothing to write at runtime, so no root needed (also satisfies runAsNonRoot in Kubernetes).
USER 10001:10001
ENTRYPOINT ["/bin/sh", "/bootstrap-bucket.sh"]
