# King World — Roadmap

## Phase 1 (done): core engine

- Monorepo + strict toolchain (typecheck, lint, test, build)
- SQLite schema (27 models) + ledger immutability triggers
- Integer-minor-unit money, single-writer ledger, `verifyLedger`
- Event bus + audit log, typed catalogue (~45 events)
- Swappable AI providers + deterministic mock
- Tasks (state machine, dependencies, cycle detection), memory (4 kinds, decay),
  world (dual clock), company, approvals (freeze + single-flight replay)
- Agent runtime (think-act-observe) + 4 role profiles + 19 tools
- REST API (auth, RBAC, approvals replay, agent wakeup), seed, 25 tests,
  operator dashboard, docs

## Phase 2: the city

1. Postgres migration (`enum`, `jsonb`, `numeric(19,4)`), BigInt money.
2. Districts + geometry (location metadata), capacity enforcement in UI.
3. Daily routine engine driven by the event stream (no polling).
4. Relationship graph from co-location + conversation history.
5. Salary payroll heartbeat + market purchases with price modifiers.
6. Vector-backed memory retrieval behind `MemoryRetriever`.
7. Real-time dashboard (SSE on `EventLog`) + role-based views.
8. Nightly `verifyLedger` + treasury reconciliation job.

## Non-goals

- Multi-region deployment, fine-grained human RBAC, fiat rails — all post-city.
