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
- `apps/web` — React + Tailwind operator dashboard (World, Company, Agents,
  Tasks, Communication, Economy, Approvals, Activity)
- `packages/*` — shared, database, security, events, ai, economy, company,
  world, tasks, memory, approvals, agents, tools
- `database/` — Prisma SQLite schema + migrations + idempotent `seed.ts`
- `tests/` — 25 vitest suites (finance edge cases, core, permissions, API)
- `docs/` — ARCHITECTURE, SECURITY, API, ROADMAP

See `plan.md` for the handover record and `docs/` for details.
