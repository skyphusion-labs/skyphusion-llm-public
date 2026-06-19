# CI agent image for the Jenkins `skyphusion-ci` pipeline.
#
# Plain node:22 plus the Docker CLI + buildx, so Jenkins deploy stages can
# reach the host Docker daemon when an image build is needed. This Worker
# deploy is TypeScript-only; the client is here for optional CI use.
# bind-mounts /var/run/docker.sock and runs the agent with the `docker` group, so
# this image only needs the client, not a daemon.
#
# Build + publish on dischord or the laptop:
#   docker build -f ci/node-docker.Dockerfile -t ghcr.io/skyphusion-labs/ci-node-docker:latest .
#   docker push ghcr.io/skyphusion-labs/ci-node-docker:latest   # optional; Jenkins uses the local image if present
FROM node:26

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin \
 && rm -rf /var/lib/apt/lists/*
