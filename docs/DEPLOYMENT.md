# Deployment

AgentWorld runs as **one process** (API, simulation, workers and, optionally, the dashboard) on **one SQLite
file**. That keeps a deployment simple, and it also sets the limits listed at the end of this page.

## Docker Compose (recommended)

```bash
export JWT_SECRET=$(openssl rand -hex 48)
export VAULT_MASTER_KEY=$(openssl rand -base64 32)
export SEED_OWNER_PASSWORD='choose-a-long-password'
export EXEC_ALLOW_UNSANDBOXED_PRODUCTION=true   # explained under "Agent commands and the sandbox"
docker compose up --build
```

Open <http://localhost:4000> and sign in as `owner@agentworld.local` (change it with `SEED_OWNER_EMAIL`).
Compose refuses to start while a required secret is missing.

| Variable | Required | Meaning |
|---|---|---|
| `JWT_SECRET` | yes | Signs sessions. 32+ characters; the development placeholder is refused. |
| `VAULT_MASTER_KEY` | yes | Encrypts stored credentials. Base64 of 32 bytes. **Losing it makes stored credentials unreadable.** |
| `SEED_OWNER_PASSWORD` | yes | Password of the first owner account (10+ characters, the default is refused). |
| `EXEC_ALLOW_UNSANDBOXED_PRODUCTION` | yes | Set to `true` to accept that agent commands run unsandboxed inside the container (see below). |
| `SEED_OWNER_EMAIL` | no | First owner's email. |
| `AGENTWORLD_PORT` | no | Host port, default `4000`. |

On the first start of a data volume the container applies every migration (`prisma migrate deploy`) and seeds
the demo world once. Later starts only migrate. The seed is not repeated, so deleting a demo company stays
deleted.

Two volumes hold state: `data` (the database, `/data`) and `workspaces` (agent working directories).
Everything else in the container is disposable.

### Agent commands and the sandbox

Compose sets `EXEC_SANDBOX=local`: agent commands run **inside the AgentWorld container**, protected only by
the command policy. In production the server refuses to start like this unless
`EXEC_ALLOW_UNSANDBOXED_PRODUCTION=true`, so compose makes you set it yourself instead of hiding the choice.
That is acceptable with the offline `mock` provider or agents you fully trust, and **not**
with real AI providers and untrusted prompts. The real sandbox (one throwaway container per command) needs
access to a Docker daemon; giving the container the host's Docker socket would hand it control of the host.
See [SANDBOX](SANDBOX.md) for options.

## Without Docker

```bash
cp .env.example .env              # set NODE_ENV=production, JWT_SECRET, SEED_OWNER_PASSWORD, VAULT_MASTER_KEY,
                                  # DATABASE_URL (absolute path), SERVE_WEB=true, EXEC_SANDBOX (docker, or local plus
                                  # EXEC_ALLOW_UNSANDBOXED_PRODUCTION=true)
VITE_API_BASE_URL=/api/v1 npm run build
npx prisma migrate deploy
npm run db:seed                   # first time only
npm start
```

`SERVE_WEB=true` makes the API serve `apps/web/dist`. `VITE_API_BASE_URL` is baked in at build time, so build
the dashboard with `/api/v1` for same-origin serving.

## HTTPS

The app speaks plain HTTP. Put a reverse proxy (Caddy, nginx, a cloud load balancer) in front for TLS, and set
`TRUST_PROXY` to the **exact** number of proxies so rate limits see real client addresses. Too high a value lets
clients spoof their address.

## Backups

```bash
npm run db:backup                      # backups/agentworld-<timestamp>.db
npm run db:backup -- /safe/place.db
docker compose exec agentworld npm run db:backup -- /data/backup.db
```

The backup is a consistent copy taken while the API runs, and it refuses to overwrite an existing file.
To restore: stop the API, replace the database file with the backup, start the API. Keep backups **and**
`VAULT_MASTER_KEY` somewhere other than the server, and test a restore once before you need it.

## Limits to know about

- **One instance only.** The simulation clock, workers and rate limiter live in the process, and SQLite is a
  single file. Running two copies against the same data is not supported. Scaling out needs Postgres
  (deferred, see [ROADMAP](ROADMAP.md)).
- **Tables grow without bound.** There is no retention for events, logs, AI usage or webhook deliveries yet.
  Watch the size of the data volume.
- **Production mode uses WAL** (`journal_mode=WAL`), which creates `-wal` and `-shm` files next to the
  database. Back up with `db:backup`, not by copying the single file while the API runs.
- **The image keeps development dependencies** because the entrypoint needs `prisma` and `tsx`.
