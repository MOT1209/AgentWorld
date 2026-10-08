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
  [now 161 tests: 149 passing + 12 Docker-sandbox skipped when Docker is absent],
  operator dashboard, docs

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

## Phases 4-10: the city (derived from the deferred list)

Derived from the original "Later: the city" list. Postgres migration stays
deferred beyond Phase 10 (infra-gated: SQLite is the documented Phase 1
default and no Docker daemon is available here). Each phase must keep
`npm run verify` green and extend existing services rather than duplicating
them (single ledger, single ToolExecutor, single event bus).

### Phase 4: districts + geometry

- `District` model (cityId, name, kind, geometry metadata) + migration,
  `Location.districtId` FK (nullable, no destructive changes)
- CRUD service + `world.*` tools + REST endpoints; snapshot/list APIs expose
  districts
- Capacity enforcement: call `assertLocationCapacity` on `moveAgent`
  (currently never invoked) and surface capacity in the dashboard

### Phase 5: daily routine engine (event-driven, no polling)

- Routine specs as data (agent routine rows: slot/activity/location/duration)
- Engine evaluated from the existing tick/WORLD_TICK path — **no new timer,
  no polling loop**; emits `ROUTINE_*` events + audit rows
- Simulation decides within routines (decision engine respects scheduled
  activity); missed/overdue routines are surfaced, never crash the tick

### Phase 6: relationship graph

- `AgentRelationship` edges updated from co-location and conversation/memory
  history via `recordInteraction`-style service; scores evolve, never grant
  permissions
- `relationship.*` tools behind ToolExecutor + REST + dashboard graph view
- Social decision branch in the simulation may read relationship scores

### Phase 7: payroll heartbeat + market purchases

- Salary payroll: idempotent per-cycle run triggered from the existing
  heartbeat path (single-writer ledger, `PAYROLL_*` events)
- Market purchases with price modifiers: catalog/price rows, `market.*` tools
  that route through `payPurchase`/treasury withdrawal (no new financial
  system — extend `packages/economy`)

### Phase 8: vector-backed memory retrieval

- `MemoryRetriever` interface; vector/similarity implementation behind it
  (same store/decay semantics, scores as today); runtime + tools switch to
  the interface, existing callers unchanged

### Phase 9: real-time dashboard + role-based views

- SSE streaming already exists (`/events/stream`); add replay/cursor from
  `EventLog` if missing + live event feed in the dashboard
- Role-based views (agent / reviewer / king) gated on existing RBAC + tool
  permissions; no new auth

### Phase 10: nightly ledger + treasury reconciliation

- Scheduled job (same pattern as existing heartbeat scheduler) running
  `verifyLedger` + treasury reconciliation; emits events + audit rows, alert
  row/escalation on imbalance, dashboard/REST status surface

## Deferred beyond Phase 10

- Postgres migration (`enum`, `jsonb`, `numeric(19,4)`), BigInt money —
  requires Docker/Postgres infra not present in this environment.

## Non-goals

- Multi-region deployment, fine-grained human RBAC, fiat rails - all post-city.
