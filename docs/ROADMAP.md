# King World - Roadmap

## Phase 1 (done): core engine

Historical snapshot at Phase 1 close; current totals in brackets.

- Monorepo + strict toolchain (typecheck, lint, test, build)
- SQLite schema (27 models) + ledger immutability triggers [now 38 models]
- Integer-minor-unit money, single-writer ledger, `verifyLedger`
- Event bus + audit log, typed catalogue (~45 events) [now ~80 types]
- Swappable AI providers + deterministic mock + `ModelRouter`
- Tasks (state machine, dependencies, cycle detection), memory (4 kinds, decay),
  world (dual clock), company, approvals (freeze + single-flight replay)
- Agent runtime (think-act-observe) + 4 role profiles + 19 tools
  [now 55 tools]
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

## Phase 3: real workspace & execution runtime

Audit: `docs/PHASE3-AUDIT.md`. Architecture: `docs/AGENTWORLD_PHASE_3_ARCHITECTURE.md`.

- [x] `Workspace`/`WorkspaceMember` models, migration, closed-root path guard,
  `packages/workspace` service, 6 `workspace.*` tools
- [x] Workspace test coverage (lifecycle + escape attacks, incl. the
  not-yet-existing-path-under-symlink case)
- [x] `Artifact` + `ExecutionJob` models; session-workspace linkage
- [x] `ExecutionBackend` abstraction: OpenCode / local process / mock
- [x] `CommandPolicy` + `ProcessManager` (caps, timeouts, abort-signal tree
  kill, POSIX process groups)
- [x] `fs.*` / `terminal.*` / `git.*` tools through the enforcement pipeline
- [x] Async execution queue + worker in `main.ts` (non-blocking, orphan
  recovery, idempotent enqueue, error categorization with bounded retries)
- [x] Verification pipeline -> `Report{kind:"EXECUTION"}` -> review handoff
- [x] Dashboard: workspaces, executions sections; `/executions` REST incl.
  spooled-output reader; queued AND running jobs are cancellable (REST 202
  for an abort-in-flight, tool `execution.cancel`)
- [x] Live OpenCode smoke test (`tests/opencode-smoke.test.ts`): opt-in via `OPENCODE_SMOKE=1`, skips cleanly when the CLI is absent
- [x] Artifact service, `/workspaces/:id/artifacts`, `/executions/:id/logs`; dashboard execution and workspace detail views
- [x] Security matrix (`tests/security-m4.test.ts`) and recovery / idempotency / cancel tests (`tests/execution-m2.test.ts`)

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
