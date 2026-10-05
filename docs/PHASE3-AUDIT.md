# AgentWorld - Phase 3 Audit

> **Status (post-implementation):** this is the pre-build baseline audit. Sections
> 3 ("Missing capabilities") and 5 (file inventory) describe the gap that
> existed then and are now closed except where `docs/ROADMAP.md` says
> otherwise. Current counts: 38 models, 55 tools, 19 packages, 7 migrations.
> Where this file says "34 tools" or "41 models" it is describing the baseline.

Full-stack diagnostic of the repository as it stands before the Phase 3 build
(real Agent Workspace + Execution Runtime). Every claim below was verified
against the tree, not against other documents.

**Baseline:** commit `1a1bfdc` plus the uncommitted workspace slice that landed
during this audit (schema `Workspace`/`WorkspaceMember`, migration
`20261001200000_phase3_workspaces`, `packages/workspace`, `workspace.*` tools,
permissions/events/enums). That slice is absorbed as the starting point of M2.

**Verification at baseline:** `npm run verify` green - typecheck, eslint, 62
tests in 9 files, API + web builds.

> **Note (as of 2026-10-04):** the figures in this audit (62 tests in 9 files,
> 41 models, 34 tools, 17 packages) are the verified **baseline snapshot** at
> the commit above and are deliberately left unchanged as a historical record.
> The current tree has **55 tools, 38 models, 19 packages, and 161 tests
> (149 passing + 12 Docker-sandbox skipped when Docker is absent)** — see
> `README.md` and `docs/ROADMAP.md` for live totals.

---

## 1. Current architecture

### 1.1 Shape

- npm workspaces monorepo: `apps/*` (api, web) + `packages/*` (17 packages:
  agents, ai, approvals, company, database, economy, events, memory,
  orchestration, runtime, security, shared, simulation, tasks, tools, workspace
  (new), world).
- ESM, TypeScript strict, Prisma 6 + SQLite (raw SQL migrations), vitest with
  `singleFork`, Express API on :4000, React dashboard on :5173.
- Cross-package imports are relative with explicit `.js` extensions; no deep
  imports into another package's `src` internals beyond that convention.
- Test DB is bootstrapped CLI-free by `tests/setup.ts`: it replays every
  `database/migrations/*/migration.sql` in sorted order and DROPs tables by
  name first - **new tables must be added to that DROP list**.

### 1.2 Layer map

| Layer | Where | State |
| --- | --- | --- |
| Schema | `database/schema.prisma` (41 models) + 5 migrations | Phase 3 workspace migration added |
| Shared kernel | `packages/shared` (enums, zod schemas, config, actor, errors) | complete |
| Security | `packages/security` (permissions, RBAC) + `packages/approvals` (approval policy, `ACTION_RISK`) | complete incl. new `workspace.execute/delete/share/admin` |
| Events | `packages/events` (catalog, bus, audit) | complete incl. `WORKSPACE_*` |
| Domain packages | tasks, economy (double-entry ledger w/ SQL triggers), memory, company, world, simulation | Phase 1+2 complete |
| Orchestration | `packages/orchestration` (plan/review/report/escalation/conflict) | Phase 2 complete, all emit events |
| AI | `packages/ai` (providers, `ModelRouter.routeModel`) | complete, mock provider runs keyless |
| Runtime | `packages/runtime` (`AgentSession` service: INITIALIZING/RUNNING/WAITING/COMPLETED/FAILED/CANCELLED, ownership, terminal finality) | complete |
| Tools | `packages/tools` - 34 tools in 14 definition files, single `ToolExecutor` enforcement (lookup -> audience -> permission -> zod -> approval -> execute -> audit) | complete through Phase 2 + 6 workspace tools |
| API | `apps/api` - 15 committed routes (+ uncommitted `session.routes.ts`, `review.routes.ts`), composition root DI, async bootstrap in `main.ts` | complete |
| Web | `apps/web` - dashboard with section nav, polling views, `Panel`/`DataTable` primitives | Phase 2 state |

### 1.3 Execution-relevant behavior that already exists

- **Tool execution pipeline** (`packages/tools/src/executor.ts`): the only
  mutation point. Risk tiers route through the approval service with replay
  support; every outcome is audited.
- **Session lifecycle** (`packages/runtime/src/session.service.ts`):
  ownership rules, event emission (`SESSION_STARTED`/`SESSION_FINISHED`), and
  `orchestrateAgentRun` in `apps/api/src/services/agent-orchestrator.ts`
  already wraps orchestrated runs in a session record.
- **Approval + risk**: `ACTION_RISK` covers all 34 tools; `ROUTINE_ACTIONS`
  marks what runs without approval. High-risk actions create approval requests
  that hold the tool call.
- **Simulation heartbeat**: `packages/simulation/src/engine.ts` runs on a
  `setInterval`; nothing in Phase 3 may block the event loop or the tick.
- **Deterministic AI**: zero-API-key operation via the `mock` provider;
  `routeModel` picks providers per configured rules.

### 1.4 Environment facts (verified)

- `npx prisma generate` works (~3s). `npx prisma --version` hangs - treat the
  CLI as "generate only"; migrations are hand-written SQL files (existing
  precedent) and `scripts/apply-migration.ts` applies them.
- `opencode` CLI `1.18.34` installed at `C:\Users\aihmo\.bun\bin\opencode.exe`;
  git `2.45.1.windows.1` present.
- Full `npm run verify` ≈ 2-3 min (tests ≈ 100s, web build ≈ 26s).

## 2. What Phase 3 must NOT rebuild

| Capability | Reuse as-is |
| --- | --- |
| Tool definition + enforcement | `ToolExecutor`, `ToolRegistry`, zod schemas |
| Approvals / risk | `ACTION_RISK`, `ROUTINE_ACTIONS`, approval service + replay |
| Sessions | `AgentSession` service - extend, never fork |
| Permissions / RBAC | `packages/security` - add strings only |
| Events / audit | catalog + `eventBus` + `recordActivity` |
| DI / bootstrap | `apps/api/src/services/composition-root.ts`, `main.ts` lifecycle |
| REST conventions | `config/routes.ts` registration, auth middleware, DTO mapping |
| Dashboard primitives | `Panel`, `DataTable`, section navigation |
| Test harness | `tests/setup.ts` DB bootstrap, `tests/helpers.ts` fixtures |

## 3. Missing capabilities (the Phase 3 gap)

### 3.1 Workspace domain - partially landed (absorbed slice)

Present: `Workspace`/`WorkspaceMember` models + migration, `WORKSPACE_*`
enums/events/permissions, `packages/workspace` service (create/get/list/status/
share/archive/reap, closed-root `resolveInRoot`, explicit access checks, no
secrets in rows), 6 `workspace.*` tools wired through registry, `ACTION_RISK`,
role allow-lists (supervisor/operator), `.gitignore` entry for `workspaces/`.

Still missing:

- No test coverage at all for the workspace slice (no `tests/workspace.test.ts`).
- No hardening proof: traversal/symlink escape tests are the acceptance bar.
- No REST routes for `/workspaces` (files listing, directory browsing).
- No linkage: `AgentSession` has no `workspaceId`; tools cannot bind a run to a
  workspace directory.
- No `Artifact` model or artifact registry (files produced by runs).
- No lifecycle wiring from sessions/executions into workspace status.

### 3.2 Execution runtime - entirely missing

- No `ExecutionBackend` abstraction (OpenCode / local process / mock).
- No OpenCode adapter anywhere (`opencode` appears in no source file).
- No `CommandPolicy` (SAFE/RESTRICTED/REQUIRES_APPROVAL/BLOCKED, argv-only,
  shell-free).
- No `ProcessManager` (spawn/status/kill/timeout/output caps/orphan cleanup).
- No `ExecutionJob` model, no async queue, no worker; no queue start/stop in
  `main.ts`.
- No `ExecutionResult` / verification pipeline (detect scripts -> run tests ->
  `Report{kind:"EXECUTION"}` -> review handoff).

### 3.3 Tools - absent

No `fs.*` (ls/read/write/mkdir/move/delete), no `terminal.exec`/`terminal.kill`,
no `git.*` (status/diff/log/branch/checkout/add/commit), no execution/artifact
tools, no GitHub integration. 34 of ~48 planned tools exist.

### 3.4 API / UI / observability - absent

- No `/workspaces`, `/executions` REST surface (workspaces) or logs endpoint.
- No dashboard section for workspaces/sessions/executions; inspector lacks
  session/workspace/backend/artifact fields.
- No `EXECUTION_*`, `PROCESS_*`, `ARTIFACT_*` events.
- No CI-visible live OpenCode smoke path.

## 4. Recommended architecture (decisions)

1. **OpenCode is one backend behind `ExecutionBackend`**, never an AI provider.
   The only files allowed to mention the binary: `packages/execution/src/backends/opencode.ts`
   + config (`OPENCODE_COMMAND` in `shared/config.ts` / `.env.example`).
   AgentWorld owns permissions, workspace binding, lifecycle and audit; the
   backend only runs a process and returns a structured `ExecutionResult`.
2. **Execution is enqueued, never inline.** HTTP handlers and tools only
   create `ExecutionJob` rows; an in-process worker (started/stopped in
   `main.ts` alongside the simulation heartbeat) claims jobs transactionally,
   runs them through a backend with concurrency limits, and persists results.
   The simulation tick must never be blocked.
3. **Two server-side gates on every filesystem/process action**: the workspace
   path guard (normalize -> resolve -> realpath -> inside-root, rejecting
   `..`, absolute smuggling and symlink escapes) and the command policy
   (argv arrays only, `shell: false`, unknown commands -> REQUIRES_APPROVAL).
   Model output is never trusted for paths or commands.
4. **Extend, never fork**: `AgentSession` gains nullable `workspaceId`/
   `backendId`; new tools go through the existing `ToolExecutor`; new events
   go through the existing catalog; new permissions are strings added to the
   existing registry with role grants.
5. **No secrets leave the server**: GitHub tokens and provider keys stay in
   env/config, are redacted from results, and never appear in prompts,
   tool args, or the dashboard. Chain-of-thought is never exposed -
   operational fields only.
6. **Additive schema/enums only**: no renames of working modules; new tables
   (`Artifact`, `ExecutionJob`) arrive with hand-written migration SQL +
   `prisma generate` + `tests/setup.ts` DROP-list entries.
7. **Testing discipline**: unit tests for path guard (escape attacks), command
   policy matrix, process kill/timeout, queue lifecycle; integration tests for
   tools through the real executor; mock/local backends in CI, exactly one
   live OpenCode smoke test against the installed binary (skipped when absent).

## 5. File inventory

### 5.1 Reuse unchanged

`packages/tools/src/executor.ts`, `registry.ts`, `types.ts`;
`packages/runtime/src/session.service.ts`; `packages/approvals/src/*`;
`packages/events/src/{bus,audit}.ts`; `tests/helpers.ts`;
`apps/api/src/services/composition-root.ts`; `apps/web/src/components/*`.

### 5.2 Modify

| File | Why |
| --- | --- |
| `database/schema.prisma` | add `Artifact`, `ExecutionJob`; `AgentSession.workspaceId`/`backendId` |
| `packages/database/src/types.ts` | re-export new models |
| `tests/setup.ts` | DROP-list for new tables |
| `packages/shared/src/{enums,config}.ts`, `.env.example` | execution statuses, `WORKSPACE_ROOT`/`OPENCODE_*`/limits |
| `packages/events/src/catalog.ts` | `EXECUTION_*`, `PROCESS_*`, `ARTIFACT_*` |
| `packages/approvals/src/approval-policy.ts` | `ACTION_RISK` + routine entries for fs/terminal/git tools |
| `packages/agents/src/role-profiles.ts` | allow-lists + permissions for new tools |
| `packages/tools/src/index.ts` | register new definition files |
| `packages/runtime/src/session.service.ts` | workspace/backend linkage fields |
| `apps/api/src/{main.ts, app.ts, config/routes.ts}` | worker lifecycle, new routes |
| `apps/web/src/App.tsx` | workspaces/executions section |
| `docs/{ROADMAP,ARCHITECTURE,API,AGENTWORLD_PHASE_3_ARCHITECTURE}.md`, `plan.md` | reconciliation (M1) |

### 5.3 Create

| Path | Contents |
| --- | --- |
| `docs/PHASE3-AUDIT.md` | this document (M0) |
| `packages/workspace/src/{fs.service,git.service,artifact.service,github.ts}.ts` | fs/git/artifact ops + GitHub abstraction, all behind the path guard |
| `tests/workspace.test.ts` | lifecycle, ownership, escape attacks |
| `packages/execution/src/{backend,command-policy,process-manager,queue,worker,verify}.ts` | ExecutionBackend + backends (`mock`, `local-process`, `opencode`), policy, queue |
| `packages/tools/src/definitions/{fs,terminal,git,execution}-tools.ts` | ~14 new tools |
| `apps/api/src/routes/{workspace,execution}.routes.ts` | REST surfaces |
| `tests/{workspace-tools,execution,queue,api-workspaces}.test.ts` | coverage |
| `scripts/smoke-opencode.md` | documented one-shot live smoke procedure |

## 6. Risks

- **Concurrent editing**: another session has been writing Phase 3 code into
  the same tree; every milestone gate re-runs `git status` and `npm run verify`
  before new edits.
- **Prisma CLI hang**: `migrate dev` may hang like `--version` did; fall back
  to hand-written SQL (already the pattern for `20261001200000_phase3_workspaces`).
- **Windows**: argv spawn with quoted `.exe` paths, path normalization across
  separators, CRLF/encoding drift -> run `scripts/normalize-encoding.mjs` after
  bulk edits.
- **Test time**: suite already ≈ 100s; execution tests must use `node -e`
  fixtures, no network, no real LLM calls.
- **Stray files**: `التقرير.html` appeared untracked during the audit; do not
  delete, do not stage.

## 7. Definition-of-done checklist (Phase 3)

Status below reflects the audit at commit `980a1e1` (execution runtime landed
and verified: typecheck, lint, 170+ tests, build).

- [x] Workspace covered by tests (lifecycle + escape attacks)
- [x] `ExecutionBackend` + OpenCode/Local/Mock behind one interface
- [x] `CommandPolicy` + `ProcessManager` with caps, timeouts, orphan cleanup
- [x] fs/terminal/git tools enforcement-proven through `ToolExecutor`
- [x] Async queue in `main.ts`, non-blocking, cancellable (queued and running
  jobs; running cancellation aborts the live child and settles CANCELLED),
  retry-classified, idempotent enqueue
- [x] Verification pipeline producing `Report{kind:"EXECUTION"}` -> review
- [x] `/workspaces`, `/executions` REST + dashboard section
- [ ] One live OpenCode smoke run (documented, skip-if-absent)
- [ ] All stale docs reconciled; `npm run verify` green (ROADMAP and this
  checklist reconciled; README counts and API doc execution/workspaces
  sections still pending)
