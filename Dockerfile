# syntax=docker/dockerfile:1
#
# AgentWorld: one container serving the API and the built dashboard on one port.
#
#   docker compose up --build        (see docker-compose.yml and docs/DEPLOYMENT.md)
#
# Single stage on purpose: the entrypoint runs `prisma migrate deploy` and the seed (`tsx`), and both are
# devDependencies, so the runtime needs them. Trimming the image is a later optimisation.

FROM node:22-bookworm-slim

# Prisma's query engine needs OpenSSL; ca-certificates lets the app call real AI providers over HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Same origin: the dashboard calls /api/v1 on whatever host served it.
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

RUN npm ci \
 && npm run db:generate \
 && npm run build \
 && npm cache clean --force

# Writable state lives in volumes: the database in /data, agent workspaces in /app/workspaces.
# The unprivileged `node` user owns both (a new named volume copies this ownership).
RUN mkdir -p /data /app/workspaces \
 && chown node:node /app /data /app/workspaces \
 && chmod +x docker/entrypoint.sh

# No update checks or telemetry calls at start.
ENV CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1

ENV NODE_ENV=production \
    PORT=4000 \
    SERVE_WEB=1 \
    DATABASE_URL=file:/data/agentworld.db

USER node
EXPOSE 4000
VOLUME ["/data", "/app/workspaces"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker/entrypoint.sh"]
