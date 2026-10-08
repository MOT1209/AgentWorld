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

### Phase 6: relationship graph — ✅ delivered

- `AgentRelationship` edges updated from interaction evidence via
  `packages/agents/src/relationships.ts` (`recordInteraction` with kinds
  CONVERSATION / COLLABORATION / CO_LOCATION / OUTCOME); scores evolve,
  never grant permissions
- `relationship.*` tools behind ToolExecutor+ REST (`/api/v1/relationships`)
- Evolution is measured, not asserted: `evolveReputation` derives
  `Agent.reputation` movement from the same evidence the Performance Center
  shows, capped at 5 points per pass, with `AGENT_REPUTATION_CHANGED` audited

### Phase 6b: Performance Center + Academy — ✅ delivered

- Performance Center: `agentPerformance` / `companyPerformance` computed from
  real Task / TaskReview / ExecutionJob / AiUsage rows; REST
  `/api/v1/performance` + PerformanceView dashboard (rates color-coded, no
  data shown as "no data", never 0%)
- Academy: `TrainingRun` lifecycle (start → evaluate/fail, terminal-once);
  only a passed run (stored score ≥ passing score) widens `Agent.skills`;
  evaluation requires human authority (AGENT_MODIFY). `academy.train` /
  `academy.list` tools, `EVALUATION_RECORDED` / `AGENT_TRAINED` events,
  REST `/api/v1/academy`

### Phase 7: payroll heartbeat — ✅ core delivered; market purchases pending

- Salary payroll: `runPayrollCycle` triggered from the existing tick path on
  the first tick of a new simulated day; idempotent per (company, agent,
  day) via ledger idempotency keys — a retried pass replays as a no-op, and
  shortfalls are recorded, never crash the tick (single-writer ledger
  preserved, `SALARY_PAID` events)
- Market purchases with price modifiers: catalog/price rows, `market.*` tools
  that route through `payPurchase`/treasury withdrawal (no new financial
  system — extend `packages/economy`) — **not yet delivered**

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

## Phase 11: AI platform + Software Factory (Agent 2)

Delivered on top of Phases 1-5 without duplicating their systems (single
ledger, single ToolExecutor, single event bus, existing workspace/execution
runtime).

- AI provider catalog: 20 vendors declared as data (`VENDOR_CATALOG`);
  unconfigured vendors report `configured: false` with the exact env change
  that enables them — never faked as working. Vendor model entries are
  advisory and unavailable until their adapter is genuinely configured.
- Model routing by capability, task type, context size, cost budget and
  availability (`maxCostPer1k`, `minContextWindow`, `estimatedTokens` on
  routing requests, tools and the gateway; cheapest qualifying model wins).
- Connector marketplace metadata (version, category, capabilities, required
  scopes, security posture) plus transports: GraphQL (real), outbound
  webhook (real, SSRF-guarded, never forwards credentials), and honest
  unavailable bridges for CLI / database / external-MCP / WebSocket (calls
  fail loudly, nothing reaches the network).
- MCP: 21 tools (agents, companies, projects, tasks, memory, testing,
  world, economy, factory, providers, models, connectors, webhooks,
  approvals, sessions, workspaces, plans) and 10 resources, all scoped and
  audited; MCP never bypasses AgentWorld security.
- TestingEngine adapters: browser (command or probe, else simulated ERROR),
  mobile (command or simulated ERROR — device results never faked),
  security (real in-process self-checks), performance (real latency probes
  stored historically), testerarmy (reserved honest ERROR).
- Factory intelligence: managed-project view with lifecycle mapping
  (DISCOVERING..DEPLOYED), team suggestions (suggest-only; assignment stays
  with delegation), bounded failure analysis + single fix-task creation,
  pre-PR review gate (recorded, never opens the PR), deployment adapters
  (custom executes for real; others BLOCKED with the missing piece named;
  rollback only with a recorded command). New events:
  FACTORY_REVIEW_RECORDED, FACTORY_DEPLOY_RECORDED.
- Public API: cursor pagination (`cursor`/`limit`/`nextCursor`) on factory
  and testing run lists; new factory endpoints (project, team, failure,
  fix-task, review, deploy, deployments, rollback); providers endpoint
  includes the vendor catalog; connectors endpoint includes full metadata.
- Agent tools: `factory.project`, `factory.team.suggest`,
  `factory.failure.analyze`, `factory.fix`, `factory.review`,
  `factory.deploy`, `provider.list` (with catalog), `provider.complete`
  (budget/context routing), `testing.run` (suite-only QA runs).
- Dashboard: Factory (runs, lifecycle, tests, review, PR, deployments,
  stage actions), Testing (queue + history), Integrations (provider
  catalog, connector marketplace).
- Docs: `docs/FACTORY.md` (operator contract), `docs/API.md` (new
  endpoints), this roadmap entry.
- Tests: `tests/factory-platform.test.ts` (catalog, routing, transports,
  MCP, QA adapters, factory intelligence).

Remaining (genuine limitations, not roadmap debt):

- Deployments live on the run record + events; a dedicated Deployment table
  (relations, indexes, SQL history) is the next schema step when needed.
- No bundled adapters for Bedrock/Vertex native APIs, external MCP clients,
  WebSocket feeds, or device farms: all are represented as unavailable with
  explicit enable paths, never faked.
- Browser QA runs commands/probes but drives no real browser session yet;
  a Playwright-backed runner is the next QA step.

## Deferred beyond Phase 10

- Postgres migration (`enum`, `jsonb`, `numeric(19,4)`), BigInt money —
  requires Docker/Postgres infra not present in this environment.

## Non-goals

- Multi-region deployment, fine-grained human RBAC, fiat rails - all post-city.
