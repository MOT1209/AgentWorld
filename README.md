# AgentWorld — King World Phase 1

AI Agent Company World: simulated digital company where AI agents hold jobs,
money, identities, memories and relationships.

Phase 1 (core engine) is complete: `npm run verify` passes
(typecheck -> lint -> test -> build).

## Quick start

```bash
npm install
cp .env.example .env
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev         # API on :4000
npm run dev:web     # Dashboard on :5173
```

Runs end to end with zero API keys via the deterministic `mock` provider.

## Layout

- `apps/api` — Express REST (`/api/v1`), JWT auth, RBAC, approval replay, agent wakeup
- `apps/web` — React + Tailwind operator dashboard, including a minimal
  three.js Simulation view (World, Simulation, Company, Agents, Tasks,
  Communication, Economy, Approvals, Activity)
- `packages/*` — shared, database, security, events, ai, economy, company,
  world, tasks, memory, approvals, agents, tools, simulation
- `packages/simulation` — needs, skills, goals, activities, deterministic
  decision engine, validated action system, world clock control, tick loop
- `database/` — Prisma SQLite schema + migrations + idempotent `seed.ts`
- `tests/` — vitest suites (finance edge cases, core, permissions, API,
  simulation unit + engine integration)
- `docs/` — ARCHITECTURE, SIMULATION_ENGINE, SECURITY, API, ROADMAP

## Simulation

The World row is the single source of truth for status (`INITIALIZING` ->
`RUNNING` -> `PAUSED`/`STOPPED`). A heartbeat ticks only a RUNNING world; each
tick advances simulated time, finishes due activities, decays needs, and asks
the deterministic decision engine what a free agent should do. Decisions are
validated by the same `validateAction` gate an operator would hit, so a bad
rule (or a future model) cannot bypass the lifecycle.

```bash
curl -X POST localhost:4000/api/v1/simulation/start  -H "Authorization: Bearer $TOKEN"
curl        localhost:4000/api/v1/simulation/state  -H "Authorization: Bearer $TOKEN"
curl -N     "localhost:4000/api/v1/events/stream?token=$TOKEN"
```

See `docs/SIMULATION_ENGINE.md`.

See `plan.md` for the handover record and `docs/` for details.
