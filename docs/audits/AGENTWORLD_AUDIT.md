# AgentWorld — Repository Audit (2026-10-11)

Scope: the checked-out tree on branch `claude/agentworld-audit-hardening-yaml8k`
(base `6476d9c`, merge of PR #14). Defects AW-01 … AW-11 and AW-14 … AW-16
were reproduced with a failing test before they were fixed; AW-17 and AW-18
are new opt-in settings tested both on and off; AW-19 adds a startup check
with a unit test. All tests live in `tests/audit-2026-10-regressions.test.ts`
and carry the finding id. AW-12 and AW-13 are documentation / test fixes.

Related: [Implementation plan](AGENTWORLD_IMPLEMENTATION_PLAN.md) ·
[Test report](AGENTWORLD_TEST_REPORT.md) ·
[Security review](AGENTWORLD_SECURITY_REVIEW.md). Historical audits
(`docs/PHASE3-AUDIT.md`, `docs/phase2-review.html`) are left unchanged.

## 1. Inventory (verified)

| Area | What exists |
|---|---|
| Apps | `apps/api` (Express, 29 route files, ~7k LOC), `apps/web` (Vite/React dashboard) |
| Packages | 24 under `packages/`: agents, ai, approvals, company, connectors, database, economy, events, execution, factory, mcp, memory, orchestration, runtime, security, shared, simulation, skills, tasks, tools, vault, webhooks, workspace, world |
| Data | Prisma 6 + SQLite, 50 models (per `check:docs`), 13 hand-written migrations, ledger immutability triggers |
| Tools | 82 agent tools behind one `ToolExecutor` (`packages/tools/src/executor.ts`) |
| MCP | **Server only**, hand-rolled JSON-RPC over HTTPS POST (`packages/mcp/src/server.ts`, `/api/v1/mcp`), 21 tools / 10 resources, API-key auth. No MCP client and no `@modelcontextprotocol/sdk` dependency. |
| AI providers | `mock` (deterministic, offline) + OpenAI-, Anthropic- and Google-compatible HTTP adapters (`packages/ai/src/providers`), shared `postJson` with timeout and error redaction |
| Execution | `ExecutionJob` queue + worker, backends `local` / `mock` / `opencode`, command policy, process manager, Docker runner |
| Skills | `packages/skills`: manifest normalizer, security analyzer, trust, permission review, installer, lockfile; installed skills never add permissions |
| Tests | 42 Vitest files (baseline), serial, one SQLite DB per file |
| CI | `.github/workflows/ci.yml`: Ubuntu + Windows × Node 20/22; check:docs, typecheck, lint, test, build; Docker sandbox image built on Linux |
| Agent guidance | No `CLAUDE.md`, `AGENTS.md`, `.claude/` or `.agent/` existed. `CLAUDE.md` added (see §5). |

## 2. Verified existing controls

Checked by reading code and by the existing + new tests passing:

- JWT: HS256 pinned, issuer + audience verified, stream tickets use a separate
  audience and 60 s TTL (`packages/security/src/tokens.ts`).
- Production refuses to start with a missing/placeholder/short `JWT_SECRET` or
  the default seed password (`packages/shared/src/config.ts`).
- bcrypt cost clamped to 10–15; >72-byte passwords refused.
- Tool pipeline order lookup → audience → permission → Zod → approval →
  execute → audit; no other REST path invokes tools (only the agent runtime
  and approval replay call `toolExecutor.invoke`).
- Agent permissions = role grant ∩ declared capabilities; human-only
  permissions are rejected at role-registry load.
- Approval replay: `claimForExecution` single-flight; uncertain failures keep
  the claim.
- Ledger: single writer, optimistic version lock, append-only `Transaction`
  triggers, transfer legs in one DB transaction, overdraft check.
- Workspace path guard: normalize → resolve → realpath of longest existing
  ancestor; `..`, drive and UNC forms refused.
- Commands: argv only, `shell: false`, env allow-list with secret-shaped keys
  and loader/PATH variables dropped.
- SSRF guard for caller-chosen URLs in production; no redirects followed.

## 3. Confirmed defects

| Id | Sev | Defect | Evidence (pre-fix) | Status |
|---|---|---|---|---|
| AW-01 | P1 | `scopeRefs` matched only `companyId` exactly, so `POST /agents` and `PATCH /agents/:id` accepted `currentCompanyId` of an invisible company: an ADMIN could plant or move an agent into another tenant. | Test got 201/200 instead of 404 | Fixed |
| AW-02 | P1 | `participantAgentIds` (array) was never scope-checked. A user could open a company-less conversation with another company's agent, message it, and trigger its run (its prompt includes its company overview; the reply is readable by the attacker). | 201 instead of 404 | Fixed |
| AW-10 | P1 | Skill install/update/assign accepted **any** APPROVED approval of the same action: not bound to the skill/agent and never consumed. One approval unlocked unlimited, different dangerous installs. | Approval for skill A installed skill B (201) | Fixed |
| AW-11 | P1 | Human-initiated approvals (`requestApproval` with a USER requester) put the user id into `requesterAgentId` (Agent FK) → 500. The whole approval-required skill install/update/assign path was unusable. | 500 on `POST /skills/external/install` | Fixed |
| AW-03 | P2 | `POST /executions/verify-report` copied commands/errors of any job id (cross-tenant read); `POST /executions` accepted another tenant's `sessionId`. | 201 instead of 404 | Fixed |
| AW-04 | P2 | `decideApproval` read `PENDING` then did an unconditional update: two concurrent decisions both succeeded, so a REJECTED request could end up APPROVED and replayable. | Both promises fulfilled | Fixed |
| AW-05 | P2 | Ledger idempotency replay ignored the payload: reusing a key with a different amount, destination or direction returned `replayed: true` for money that never moved. | Resolved instead of rejecting | Fixed |
| AW-06 | P2 | Command policy missed paths in option values (`--git-dir=/x`, `--target-directory=/tmp`, `-C/x`) and `--import=` / `--loader=` code-loading flags; a script-shaped flag value ended the inline-code scan early. | `ALLOW` instead of `REQUIRE_APPROVAL` | Fixed |
| AW-08 | P2 | MCP `tasks.create` wrote the row directly (no `TASK_CREATED` event, no activity, priority unvalidated); `testing.run` accepted any suite string. Docs claim it is "governed by the Core task engine". | Invalid priority accepted | Fixed |
| AW-09 | P2 | Connector, webhook and provider HTTP responses were buffered with `response.text()` without a size limit; connector URLs can be agent-chosen. | No cap existed | Fixed (1 MiB / 4 KiB / 8 MiB) |
| AW-07 | P3 | Login skipped bcrypt for unknown/inactive accounts → account enumeration by timing. | Helper absent | Fixed |
| AW-12 | P3 | `docs/ROADMAP.md` test/model counts stale ("313 tests", "48 models"). | `check:docs` reports 50 models | Fixed |
| AW-13 | P3 | Test bug: the OAuth tamper test changed the first signature character based on the *last* one, so ~1.6 % of runs "tampered" nothing and failed. Product code was correct. | Failed once in the final run | Fixed (test) |
| AW-14 | P1 | `conversationId` (and session, job, approval, project, department ids) were not scope-checked. `POST /agents/:id/run` with another company's conversation fed its recent messages into the caller's agent prompt and posted the reply into it (cross-tenant read **and** write). Also memory/report/task rows could be linked to foreign conversations and projects. | Run returned 200; task in foreign project 201 | Fixed (`INDIRECT_LINKS` in `scopeRefs`) |
| AW-15 | P2 | Execution idempotency keys are global; a colliding key with the same command returned the other caller's job row even when it linked a different agent. | Returned the foreign row | Fixed (links are part of the replay shape) |
| AW-16 | P2 | An authorised MCP tool call that threw was not audited at all. | No `MCP_REQUEST` row | Fixed |
| AW-17 | P2 | No four-eyes option: a human could approve a request they raised. | — (policy gap) | Added `APPROVAL_FOUR_EYES` (default off) |
| AW-18 | P2 | No pre-flight AI budget control; spend only charged after the call. | — (feature gap) | Added `AI_MIN_TREASURY_MINOR` floor (default off) |
| AW-19 | P2 | Production start only rejected the default seed password in env, not an account in the database that still accepts it. | Helper absent | Fixed (startup refuses) |

## 4. Remaining risks (not fixed)

Second pass (same day): the four-eyes rule, budget control, execution
idempotency, MCP failure audit, seeded-password and id-kind items that were
listed here are now AW-14 … AW-19. The Docker sandbox suite was also run
(see the test report). What remains:

- **Four-eyes and budget floor are off by default.** Turning them on changes
  behaviour for existing users; that is a product decision.
- **The budget floor is a floor, not a cost estimate.** A call above the floor
  can still cost more than what is left; the charge then fails (logged) and
  the next call is refused.
- **Local execution mode is host code execution** by design (`npm test`,
  `node file.js`, git hooks run agent-written files). Only the Docker sandbox
  is a boundary.
- **Path guard TOCTOU**: realpath check then use; a concurrent symlink swap
  inside the workspace could race it. Requires a process already able to
  write symlinks in the workspace (in Docker mode, a container).
- **SSRF check is production-only**; development agents can reach localhost.
- **Wallet and user ids** in bodies (`toUserId` on escalations, wallet ids on
  OWNER-only economy routes) are not resolved by `scopeRefs`. Economy writes
  are platform-owner only; escalating to an arbitrary user id was not traced
  further.

## 5. Documentation inconsistencies found

- `docs/ROADMAP.md` counts stale (fixed, AW-12).
- MCP `tasks.create` description vs. implementation (fixed by AW-08).
- `docs/SECURITY.md` did not state that local execution is host code
  execution, nor the approval/idempotency/response-cap rules (updated).
- `docs/PHASE3-AUDIT.md` figures are historical by its own note; left as is.

## 6. Dependencies / integrations not verifiable here

- Docker sandbox suite: daemon started, but `node:22-alpine` pull failed with
  HTTP 429 from Docker Hub (twice). 12 tests skipped.
- OpenCode live smoke: binary absent; skipped by design.
- Real AI vendors, GitHub, OAuth connectors: no credentials in this
  environment; only mock and unit-level behavior verified.
- Windows CI leg: not reproducible in this Linux container.
