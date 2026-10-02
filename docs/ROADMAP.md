# King World - Roadmap

## Phase 1 (done): core engine

Historical snapshot at Phase 1 close; current totals in brackets.

- Monorepo + strict toolchain (typecheck, lint, test, build)
- SQLite schema (27 models) + ledger immutability triggers [now 41 models]
- Integer-minor-unit money, single-writer ledger, `verifyLedger`
- Event bus + audit log, typed catalogue (~45 events) [now ~80 types]
- Swappable AI providers + deterministic mock + `ModelRouter`
- Tasks (state machine, dependencies, cycle detection), memory (4 kinds, decay),
  world (dual clock), company, approvals (freeze + single-flight replay)
- Agent runtime (think-act-observe) + 4 role profiles + 19 tools
  [now 34 tools]
- REST API (auth, RBAC, approvals replay, agent wakeup), seed, 25 tests
  [now 62 tests], operator dashboard, docs

## Phase 2 (done): orchestration

Delivered as "the orchestration layer" rather than the originally sketched
city features (those moved to "Later"):

- `Plan` lifecycle with human-only `approvePlan`, delegation (capability match,
  workload policy, anti name-branching), `policy-engine` verdicts
- `AgentSession`, `TaskReview`, `Report`, `Escalation`, `DecisionConflict`
  services, all emitting events + audit rows
- Orchestration tools (`plan.*`, `review.submit`, `report.submit`,
  `agent.escalate`, `session.*`) behind the single `ToolExecutor`
- REST: `/plans`, `/sessions`, `/reviews`, `/reports`, `/escalations`,
  `/conflicts`
- Session-wrapped agent runs (`orchestrateAgentRun`), approval policy engine

## Phase 3 (in progress): real workspace & execution runtime

Audit: `docs/PHASE3-AUDIT.md`. Architecture: `docs/AGENTWORLD_PHASE_3_ARCHITECTURE.md`.

- [x] `Workspace`/`WorkspaceMember` models, migration, closed-root path guard,
  `packages/workspace` service, 6 `workspace.*` tools
- [ ] Workspace test coverage (lifecycle + escape attacks)
- [ ] `Artifact` + `ExecutionJob` models; session-workspace linkage
- [ ] `ExecutionBackend` abstraction: OpenCode / local process / mock
- [ ] `CommandPolicy` + `ProcessManager` (caps, timeouts, orphan cleanup)
- [ ] `fs.*` / `terminal.*` / `git.*` tools through the enforcement pipeline
- [ ] Async execution queue + worker in `main.ts`
- [ ] Verification pipeline -> `Report{kind:"EXECUTION"}` -> review handoff
- [ ] Dashboard: workspaces, sessions, executions
- [ ] One documented live OpenCode smoke run

## Later: the city

The originally sketched Phase 2 city features, deferred:

1. Postgres migration (`enum`, `jsonb`, `numeric(19,4)`), BigInt money.
2. Districts + geometry (location metadata), capacity enforcement in UI.
3. Daily routine engine driven by the event stream (no polling).
4. Relationship graph from co-location + conversation history.
5. Salary payroll heartbeat + market purchases with price modifiers.
6. Vector-backed memory retrieval behind `MemoryRetriever`.
7. Real-time dashboard (SSE on `EventLog`) + role-based views.
8. Nightly `verifyLedger` + treasury reconciliation job.

## Non-goals

- Multi-region deployment, fine-grained human RBAC, fiat rails - all post-city.
