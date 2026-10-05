# Agent sandbox image. Build: docker build -t kingworld-sandbox:1 docker/sandbox
#
# Deliberately small: the toolchains the command policy allows (node, python,
# git, make) and nothing else. No credentials, no docker CLI, no ssh client.
# The container is started by the DockerRunner as a non-root numeric user with
# no network, a read-only root filesystem and all capabilities dropped; none of
# that is configured here so the image cannot weaken it.
FROM node:22-alpine

RUN apk add --no-cache git python3 make \
 && rm -rf /var/cache/apk/*

ENV HOME=/tmp
WORKDIR /work
