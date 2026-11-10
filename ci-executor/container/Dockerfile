# The image every first-party CI job runs in (#415): Node and git, nothing else.
#
# NODE_VERSION is the current Node LTS line. A project that needs another line
# rebuilds with `--build-arg NODE_VERSION=24` (or edits this default) and
# redeploys the executor; the image is the executor's, not the project's.
ARG NODE_VERSION=26
FROM node:${NODE_VERSION}-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY agent.mjs prepare.sh trust-ca.sh entrypoint.sh /opt/stratum/
RUN chmod 0755 /opt/stratum/*.sh /opt/stratum/agent.mjs && mkdir -p /job /workspace

WORKDIR /workspace
ENTRYPOINT ["/opt/stratum/entrypoint.sh"]
