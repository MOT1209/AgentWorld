# AgentWorld — Phase 3 Architecture

**Status:** design document (Phase 3 §4), reconciled against the tree during the
M1 audit pass. Implementation status lives in `docs/PHASE3-AUDIT.md` §7 and
`docs/ROADMAP.md`.
**Rule:** simulation state and work execution state stay decoupled. A workspace
failure never crashes the world — the task becomes FAILED/BLOCKED per policy,
the failure becomes an event, the agent stays available for recovery.

> **Current totals (as of 2026-10-04):** the baseline figures in §1 below (34
> tools, 62 tests) describe the pre–Phase-3 M1 snapshot this document was
> written against. After the Phase 3 execution tools landed the tree now has
> **49 tools, 38 models, and 161 tests (149 passing + 12 Docker-sandbox skipped
> when Docker is absent)**. The inline §1 numbers are left intact as the
> historical design baseline; they are not a claim about the current tree.

---

## 1. Current architecture (what exists)

### 1.1 Phase 1 — core engine (complete, tested)

- **Ledger** (`packages/economy/src/ledger.service.ts`): sole writer of
  `Wallet.balanceMinor`. Atomicity, no-overdraft, double entry
  (`transferGroupId`), idempotency (`idempotencyKey` + unique index),
  immutability (SQLite triggers), optimistic locking (`version`), sorted
  two-wallet lock order. `verifyLedger()` replays and proves balances.
- **Events + audit** (`packages/events`): typed catalogue (~60 types),
  `eventBus` (persist in caller transaction + failure-isolated fan-out),
  `ActivityLog` (denials recorded like successes).
- **AI providers** (`packages/ai`): `AIProvider` interface
  (`complete({model,messages,tools,temperature,maxTokens,timeoutMs})` →
  `{content,toolCalls,finishReason,usage,providerId,model,latencyMs}`),
  adapters for OpenAI-compatible / Anthropic-compatible / Google / deterministic
  `mock`. `ProviderRegistry.require(id)` resolves + availability-checks.
  Agents reference `providerId` as data. `ModelRouter.routeModel`
  (`packages/ai/src/router.ts`) picks a provider per configured rules.
- **Agent runtime** (`packages/agents/src/runtime.ts`): think-act-observe loop
  over `runAgent({agentId,trigger,conversationId?,taskId?,userMessage?})`.
  The runtime holds **no DB handle**; its only capability is the injected
  `ToolInvoker`. Bounded iterations, `COMPLETED | FAILED | AWAITING_APPROVAL |
  MAX_ITERATIONS`, persists reply as `Message`, writes 3 memories per run,
  rests to `IDLE` (or `WAITING` on approval). HTTP entry via
  `orchestrateAgentRun`; wakeup via `MESSAGE_SENT.notifyAgentId` subscription.
- **Tools** (`packages/tools`, 34 built-ins incl. 6 `workspace.*`):
  `ToolExecutor` enforces
  lookup → audience → permission → Zod → approval → execute → audit.
  Every outcome writes `ToolInvocation`. Approval replay re-invokes frozen
  payloads exactly once (`claimForExecution` single-flight).
- **Tasks / memory / world / company / approvals / API / dashboard / seed /
  62 tests**: per `docs/ARCHITECTURE.md`. All green (`npm run verify`).

### 1.2 Phase 2 — orchestration (complete, tested)

| Piece | State |
|---|---|
| `Plan` model + `plan.service.ts` (create/update/transition/human `approvePlan`) | ✅ service-complete |
| `delegation.service.ts` (capable → active → least-busy, anti name-branching, max 3 re-delegations) + `workload.ts` (pure capacity/load policy) | ✅ service-complete |
| `capabilities.ts` (task.type ↔ agent capability match) | ✅ pure, wired into delegation |
| `hierarchy.ts` (escalation chains, cycle guard) + `hierarchy-sync.ts` (roles → `AgentHierarchy` rows) | ✅ pure policy + row sync |
| `policy-engine.ts` (ALLOW/REQUIRE_APPROVAL/DENY verdicts as data) | ✅ engine-complete, caller-wired |
| `AgentSession`, `TaskReview`, `Report`, `Escalation`, `AgentHierarchy`, `DecisionConflict` models | ✅ services + emitters (`session.service`, review/report/escalation/conflict services) |
| `PLAN_*/SESSION_*/TASK_REVIEWED/REPORT_WRITTEN/ESCALATION_*/DECISION_CONFLICT_*` event types | ✅ published by the services |
| Permissions (`plan.*`, `task.review`, `report.create`, `agent.escalate`, `session.read/start`, `workspace.*`) | ✅ strings + RBAC grants; `workspace.*` now has model/service/tools |
| Role allow-lists reference `plan.*`, `review.submit`, `report.submit`, `agent.escalate`, `session.*`, `workspace.*` | ✅ matching `ToolDefinition`s registered in `BUILT_IN_TOOLS` |
| `ACTION_RISK` coverage | ✅ complete for all 34 tools; routine list keeps LOW/LOW-risk tools approval-free |
| REST: `/plans`, `/sessions`, `/reviews`, `/reports`, `/escalations`, `/conflicts` | ✅ registered in `config/routes.ts` |

### 1.3 What the master prompt assumes but still does NOT exist here

No 3D environment (contract hooks only: `workspaceLocationId`), no GitHub
integration, no OpenCode adapter, no terminal/filesystem/git tools, no
execution queue/backends, no artifacts, no browser tooling. The **workspace
system itself now exists** (models, migration, closed-root path guard,
`packages/workspace` service, `workspace.*` tools, `/workspaces` REST).
Reference implementation for the missing patterns: **cubefarm**
(`github.com/leonvanzyl/cubefarm`); Phase 3 ports the *patterns*, not the
code, and wraps them in AgentWorld's permission/approval/audit layer
(cubefarm's trust model — prompt-based rules + auto-approve-all — is
explicitly **not** adopted; see §6).

### 1.4 Current state vs Phase 3 target

| Subsystem | Current state | Phase 3 target |
|---|---|---|
| Workspace models/service | ✅ `Workspace`/`WorkspaceMember`, migration, `packages/workspace` | + tests (lifecycle, escape attacks), TTL reap wired |
| Path guard | ✅ `resolveInRoot` (normalize → resolve → realpath → inside-root) | + proven by attack tests in every fs/terminal/git tool |
| Workspace tools | ✅ 6 (`workspace.create/list/get/status/share/archive`) | + `/workspaces/:id/files` browsing |
| Session ↔ workspace | ❌ no linkage | `AgentSession.workspaceId`/`backendId` |
| Artifacts | ❌ none | `Artifact` model + registry (produced by runs) |
| Execution backends | ❌ none | `ExecutionBackend` = OpenCode / local / mock |
| Command policy | ❌ none | `CommandPolicy` SAFE/RESTRICTED/REQUIRES_APPROVAL/BLOCKED, argv-only |
| Process manager | ❌ none | spawn/kill/timeout/output caps/orphan cleanup |
| Queue | ❌ inline only | `ExecutionJob` rows + in-process worker in `main.ts` |
| fs/terminal/git tools | ❌ none | ~14 new tools via `ToolExecutor` |
| Verification pipeline | ❌ none | detect scripts → run tests → `Report{kind:"EXECUTION"}` → review |
| API | ✅ `/sessions`, `/workspaces` (no file browsing) | + `/executions` (enqueue/list/logs) |
| Dashboard | ❌ no workspace/execution views | workspaces + sessions + executions + inspector fields |
| OpenCode smoke | ❌ never invoked | one documented live run (skip-if-absent) |

---

## 2. Workspace architecture (§§5–9, 46–48)

### 2.1 `AgentWorkspace` — first-class, independent of personality/state

New package `packages/workspace/` + Prisma models:

```prisma
model Workspace {
  id            String   @id @default(cuid())
  name          String
  agentId       String?  // primary holder; null = shared/team
  projectId     String?
  type          String   // PERSONAL | PROJECT | TEMPORARY | SHARED
  path          String   // absolute, under an approved root
  status        String   // CREATING | READY | BUSY | PAUSED | ERROR | ARCHIVED
  environment   String   // JSON: runtime, package manager, commands, limits
  workspaceLocationId String? // 3D mapping hook (§44-45)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
model WorkspaceMember { workspaceId, agentId, role, @@unique([workspaceId, agentId]) }
```

- One primary workspace per agent; multiple project workspaces allowed by the
  model from day one (§46). Temporary execution environments are rows with
  `type=TEMPORARY` + TTL, reaped by a sweeper.
- A project workspace carries `{ repository, branch, workingDirectory,
  taskContext, envConfig, sessionRef, recentExecutions, results }` (§9) — mostly
  as conventions over `path` + `environment` JSON + relations, not new tables.
- Creation flow (§47): request → permission check → resolve project → create
  directory → init env → init git if needed → register → READY (else ERROR).
  Every step emits events; failure never throws into the simulation.

### 2.2 Workspace isolation (§§8, 21–22, 51)

- Access control: `workspace.read/write/execute/delete/share/admin`
  permissions (read/write strings exist; the rest are added) checked in a new
  `workspace.*` tool family **and** in every filesystem/terminal/git tool via a
  shared `resolveWorkspaceRoot()` guard.
- Path contract (server-side, never trust model output): normalize →
  must-resolve-inside an authorized root → reject `..` escapes, absolute-path
  smuggling, and symlinks pointing outside (resolved with `realpath` before
  every operation).
- Secrets: environment variables are filtered (`ANTHROPIC_*/CLAUDE_*/GH_TOKEN`
  stripped from agent-visible env, following cubefarm's stripping + our
  secret-redacting logger). Workspace rows store **references**, never secret
  values (§48).

---

## 3. Runtime architecture (§§10–14) and session lifecycle (§§11–12)

### 3.1 `AgentRuntime` — provider-independent (§10)

New package `packages/runtime/` owning the Task → Workspace pipeline (§14):

```
Task → Determine Agent (delegation.service) → Resolve Workspace
→ Create AgentSession row → Prepare ExecutionContext → ModelRouter select
→ Start Runtime → Execute (existing runAgent via ToolInvoker) → Verify
→ ExecutionResult → Task update → Report → Review delegation
```

- The runtime **reuses** `runAgent` (never forks it): the workspace is exposed
  to the model as tools (`workspace.*`, `fs.*`, `terminal.*`, `git.*`), so the
  existing think-act-observe loop, permission checks, approval holds, memory
  writes, and outcome taxonomy all keep working unchanged.
- Runtime failure contract (§2 of master prompt): catch → classify (§37) →
  `AgentSession.status=FAILED`, task FAILED/BLOCKED per retry policy, emit
  `SESSION_FINISHED{status:FAILED}` + task events, agent back to IDLE. The
  world tick never depends on runtime promises.

### 3.2 Session lifecycle (§§11–12)

`AgentSession.status`: `INITIALIZING → PREPARING → RUNNING ⇄ WAITING /
EXECUTING_TOOL → VERIFYING → COMPLETED`, with `RUNNING → FAILED → RECOVERY →
RETRY | ESCALATE | CANCEL`. Persisted fields per master prompt §12
(`workspaceId`, `taskId`, `provider`, `model`, `contextSummary`,
`outputSummary`, `error`, `metadata` — no secrets) plus `correlationId`
for log/event joins. Session *service* (`packages/runtime/session.service.ts`)
is the missing Phase 2 piece, built first.

### 3.3 ExecutionContext (§13)

Built by `buildExecutionContext()`: agent identity/role/capabilities/goals,
task + satisfied dependencies, top-k memories, project, workspace
(repo/branch/roots), allowed tools = `specsFor(effectivePermissions,
role.allowedTools)`, constraints, expected output, approval requirements.
Deliberately **excludes** unrelated world state (ledger balances, other
agents' memories, provider secrets).

---

## 4. Provider integration (§§15–17)

- `AIProvider` stays the seam; vendor SDKs never touch the domain.
- `OpenCodeAdapter implements AIProvider` (§15): launches a session with
  context + workspace + task + allowed tools, streams output, captures
  result/errors, terminates. OpenCode-specific logic lives **only** in
  `packages/ai/src/providers/opencode.ts`, mirroring cubefarm's per-CLI
  modules (`clis.ts` pattern).
- `ModelRouter` (§§16–17, new `packages/ai/src/router.ts`): request
  `{provider?, model?, capability, latency, reasoning}` → ranked providers →
  fallback chain on `PROVIDER_FAILURE`. Coding tasks → code-capable,
  planning → reasoning-capable, simple → fast/cheap. Uses Phase 2
  `Agent.routingOverrides` (authoritative columns win when overrides absent).

---

## 5. Tool model (§§26–29) and execution pipeline (§27)

Extend — never fork — `ToolRegistry`. New definition files:

| File | Tools | Permission | Risk |
|---|---|---|---|
| `workspace-tools.ts` | `workspace.create/read/list/status/share` | `workspace.read/write` | LOW/MEDIUM |
| `fs-tools.ts` | `fs.read/write/ls/search/mkdir/move/delete` (root-guarded) | `workspace.write` (+read variant) | LOW (write→MEDIUM) |
| `terminal-tools.ts` | `terminal.exec` (cmd policy, timeout, cwd=root, output cap) + `terminal.kill` | `workspace.execute` (new) | HIGH → approval-gated by default |
| `git-tools.ts` | `git.status/branch/diff/log/commit` (no push to protected branches) | `workspace.write` | LOW (`commit`→MEDIUM) |
| `github-tools.ts` | `github.issue/pr-read/pr-comment` via `gh` CLI (cubefarm `github.ts` pattern) | `workspace.read` | MEDIUM |
| `plan/review/report/session/escalation-tools.ts` | the 7 allow-listed-but-missing tools from §1.2 | existing perms | LOW |

- Every tool follows the existing pipeline (§27): schema → permission →
  risk → approval → execute → validate → audit → normalized result.
- `ToolResult` (§28) maps 1:1 onto existing `ToolExecutionResult`
  (`{status,data|error,approvalRequestId,durationMs}`) — **no new shape**;
  document the mapping instead of inventing one.
- Timeouts/cancellation/retry/output caps (§29): `terminal.exec` takes
  `{timeoutMs ≤ max, maxBytes}`; cancellation via `terminal.kill` +
  session cancel flow (§54); retry policy per §37 categories (implemented in
  runtime, not per tool).
- Also fix the two Phase 2 gaps found in inspection: add the 7 missing
  `ToolDefinition`s and register missing `ACTION_RISK` entries (or explicit
  `requiresApproval:false`), otherwise models stay blind and LOW tools stay
  wrongly gated.

---

## 6. Security model (§§19–20, 31, 50–53)

| Threat | Control |
|---|---|
| Path traversal / symlink escape | `resolveWorkspaceRoot()` + `realpath` on every fs/git op |
| Command injection | No shell interpolation: argv arrays only; `CommandPolicy` ALLOW/DENY/REQUIRE_APPROVAL per command/category (§20), configurable per workspace env |
| Unrestricted host access | cwd locked to workspace root; env allow-list + secret stripping; network egress default-deny for agent CLIs |
| Secret leakage | Redacting logger + DTO rules extend to streams/artifacts; `gh` tokens never enter context |
| Privilege escalation | Role registry guard + `workspace.execute` separate from `workspace.write`; production deploys → approval policy |
| Malicious repo contents | Hooks/prompts of spawned CLIs are ours; their tool calls report back (cubefarm hook pattern) but **execution stays gated** here |
| Runaway processes/loops | `ProcessManager` (§53): every child tagged `{workspaceId,sessionId,taskId}`, timeouts, output caps, kill on session end/cancel; bounded `runAgent` iterations already exist |
| Browser session bleed (§31) | Playwright runs in the session sandbox profile; no user cookies/passwords unless explicitly granted |

Audit (§50): workspace create/delete, session create, **every** tool call
(already), terminal commands (new `terminal.exec` audit rows), file
changes (via fs-tool audit, not filesystem watchers), git ops, approvals,
provider selection, failures. Append-only tables as today.

---

## 7. Verification + ExecutionResult (§§32–35)

- `ExecutionResult` (§33) = `{sessionId,taskId,success,summary,filesChanged,
  commandsExecuted,testsRun,gitChanges,warnings,errors,duration,artifacts}` —
  persisted as a `Report{kind:EXECUTION}` row (reuse Phase 2 model) + returned
  to caller. Consumable by task update, review delegation, UI.
- Verification pipeline (§§34–35): detect project commands from workspace
  (`package.json` scripts, lockfiles — never assume `npm test`) → run
  typecheck/lint/tests/build → attach to result → `RUNNING → REVIEWING`
  (existing status) → notify assignee chain → REVIEWER role. Mirrors cubefarm's
  QA loop minus auto-merge (merging stays human-approved here).
- Retry (§§36–37): TRANSIENT→retry, PROVIDER_FAILURE→router fallback,
  COMMAND_FAILURE→analyze + conditional retry, PERMISSION→no blind retry,
  SECURITY→stop + escalate, UNKNOWN→escalate after N attempts (uses
  `Task.maxRetries/reworkCount`).

---

## 8. Frontend architecture (§§41–43) + Agent Inspector (§42)

Extend `apps/web` (React + Tailwind, token in `sessionStorage` — unchanged):

- New **Workspace** section: agent header (status/model/workspace) + file
  explorer + editor/output/terminal tabs + bottom activity/log strip (§41
  layout). File explorer lists via `fs.ls`; terminal tab streams
  `terminal.exec` output (polling first, ws later).
- **Agent Inspector** (§42) gains: current session, workspace, provider/model,
  recent tool calls + commands, files changed, tests, git status — all from
  existing endpoints + 3 new ones (`/workspaces`, `/sessions`,
  `/executions/:id`).
- Live activity (§43): operational summaries only (`tool.started /
  command.completed / test.passed`), never chain-of-thought. Phase 3 ships
  polling; websocket fan-out is an explicit follow-up (cubefarm's `/ws`
  pattern documented for it).
- Conversation timeline already distinguishes human/agent/system/tool/task
  kinds — execution events reuse the same `kind` styling.

## 9. 3D mapping (§§44–45)

No 3D engine exists in this repo. Contract-first: `Workspace.workspaceLocationId`
+ `WORKSPACE_*` events (`WORKSPACE_CREATED/STATUS_CHANGED`) + agent-state sync
table (Agent WORKING ↔ Workspace BUSY ↔ Session RUNNING; Agent IDLE ↔ READY ↔
COMPLETED — all via existing `AGENT_STATE_CHANGED` + new events). A future
renderer (cubefarm's R3F office is the reference) consumes events only;
simulation and runtime stay authoritative (§44).

---

## 10. Testing strategy

- Extend `tests/setup.ts` (CLI-free migration-SQL bootstrap — keep; Prisma CLI
  hangs in this env) to include workspace roots under `database/test-…`?
  No — test workspaces live under `C:\Users\aihmo\AppData\Local\Temp\opencode`
  (pre-approved temp), never inside the repo.
- New suites: `workspace.test.ts` (CRUD, isolation, traversal attacks),
  `runtime.test.ts` (lifecycle incl. failure→event→IDLE), `terminal.test.ts`
  (policy ALLOW/DENY/APPROVAL, timeouts, output caps), `fs-tools.test.ts`
  (boundary escapes), `git-tools.test.ts` (branch workflow, protected-branch
  refusal), `execution-result.test.ts` (verification pipeline on a fixture
  repo), `model-router.test.ts` (fallback chains).
- Adversarial tests are first-class: traversal payloads, `rm -rf /`,
  10MB-output commands, hanging commands (timeout), cross-workspace reads.
- Keep `singleFork` SQLite discipline; workspace tests use unique temp roots
  per test to avoid cross-talk.

---

## 11. Build order (maps master prompt §§5–56)

1. Phase 2 closures: session/review/report/escalation services + emitters,
   7 missing tools, `ACTION_RISK` entries, ModelRouter skeleton.
2. `Workspace` model/migration/service + isolation guard + `workspace.*` tools
   + `WORKSPACE_*` events + API + tests.
3. `ExecutionContext` builder + `AgentSession` lifecycle service.
4. `terminal.*` + `CommandPolicy` + `ProcessManager` + fs/git tools + tests.
5. `OpenCodeAdapter` (+ mock-backed `LocalAdapter` for CI) behind
   `AIProvider`; ModelRouter fallback.
6. Verification pipeline + `ExecutionResult` + review handoff + retry policy.
7. API (`/workspaces`, `/sessions`, `/executions`) + dashboard Workspace
   section + Inspector fields.
8. Artifacts, retention sweeps, cancellation/resume endpoints, docs update.

Out of scope for Phase 3: real 3D renderer (contract only), multi-region,
fiat rails, fine-grained human RBAC.
