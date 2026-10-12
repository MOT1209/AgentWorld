#!/bin/sh
# Container start: migrate, seed once, run.
set -eu

# Applies every pending migration and records it (safe to run on every start).
node_modules/.bin/prisma migrate deploy

# Seed only on the first start of a data volume. The seed re-creates its demo entities when they are
# missing, so running it on every boot would resurrect anything an operator deleted.
DATA_DIR="${AGENTWORLD_DATA_DIR:-/data}"
if [ ! -f "$DATA_DIR/.seeded" ]; then
  node_modules/.bin/tsx database/seed.ts
  touch "$DATA_DIR/.seeded"
fi

exec node dist/apps/api/src/main.js
