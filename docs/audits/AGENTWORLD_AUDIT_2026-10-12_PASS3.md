# AgentWorld — Security audit, third pass (2026-10-12)

Continues [AGENTWORLD_AUDIT_2026-10-12.md](AGENTWORLD_AUDIT_2026-10-12.md)
(AW-20…AW-23). Base: `origin/main` at `100abbc`. Earlier findings were treated
as unverified and re-checked against the code; this pass found a new class of
gap: **the company boundary was enforced for REST callers but not for agent
tool calls.** Each defect below was reproduced with a failing test before the
fix (`tests/audit3-company-boundary.test.ts`, `tests/audit3-agent-scope.test.ts`).

## Baseline (before any change)

| Check | Result |
|---|---|
| `npm run typecheck` / `lint` / `check:docs` | clean |
| `npm audit` (prod, and all at high+) | 0 vulnerabilities |
| `npm test` | 489 passed, 13 skipped (Docker sandbox suites: no Docker daemon in this environment) |
| `npm run build` | clean |

## Confirmed defects

| Id | Sev | Defect | Status |
|---|---|---|---|
| AW-24 | High | `routeByHierarchy` (auto-escalation) and `message.send` role addressing looked agents up by role across **every** company. An agent could message, and escalations were delivered to, another company's agents. An explicit foreign agent id in `message.send` was also accepted. | Fixed |
| AW-25 | High | `wallet.transfer` paid any string id: a nonexistent id got a freshly minted wallet (funds stranded), and another company's agent could be paid with no approval below the spend threshold. | Fixed: recipient must exist; cross-company transfer is `PENDING_APPROVAL` at any amount |
| AW-26 | Medium | `testing.run` URL probe (`probeHttp`) fetched any http(s) URL from the server with no outbound guard, and its error text revealed open ports (SSRF probe from an agent). | Fixed: `assertPublicUrl` in production |
| AW-27 | High | Agent tools took company, task, plan, conversation… ids from model output with no equivalent of REST `scopeRefs`: an agent could read/edit another company's tasks and plans, read its conversations, escalate into it, and `task.list`/`plan.list` listed foreign rows with no id at all. | Fixed: executor step 4b + scoped lists |

## Fixes (files)

- `packages/security/src/company-refs.ts` (new): shared reference resolution used by REST and tools.
- `apps/api/src/middleware/company-scope.ts`: thin wrappers over it (REST behaviour unchanged; 55 isolation tests unchanged and green).
- `packages/tools/src/agent-scope.ts` (new), `executor.ts` (step 4b), `types.ts` (`crossCompanyAgentRefs`).
- `packages/tools/src/definitions/{message,economy,relationship,task,plan}-tools.ts`.
- `packages/orchestration/src/{escalation,plan}.service.ts`, `packages/agents/src/communication.service.ts`.
- `packages/factory/src/testing.ts`.
- Docs: `docs/SECURITY.md`, `CHANGELOG.md`.

## Final verification

| Check | Result |
|---|---|
| `npm run typecheck` / `lint` / `check:docs` | clean |
| `npm test` (alone, after `rm -rf workspaces`) | 510 passed, 13 skipped, 0 failed |
| `npm run build` | clean |

Skipped, environment-dependent: the Docker sandbox suites (no Docker daemon in
this session) and the OpenCode smoke test. They were **not** run here; CI's
Ubuntu legs exercise Docker where available.

## Existing coverage reviewed

Production refuses unsandboxed execution (`config`/`security-hardening`
tests), symlink escape (`workspace.test.ts`), orphan job recovery
(`execution-m2.test.ts`) and ledger concurrency/idempotency (`finance.test.ts`)
have tests. Their depth was only skimmed by name, not audited line by line, so
this report does **not** claim those areas are fully verified.

## Remaining risks and open items (not fixed)

1. **F5, product decision:** 13 tools (e.g. the `relationship.*` set) are missing from the approval risk table, so `riskForAction` defaults them to HIGH and they are held for human approval even when routine. Which should be routine is a product decision; not changed.
2. **DNS rebinding:** `assertPublicUrl` resolves, then `fetch` resolves again. Connection pinning or egress filtering would close it.
3. **Path TOCTOU:** `resolveInRoot` checks realpath, then the file is used; a concurrent symlink swap inside a workspace can race it. No `O_NOFOLLOW` hardening.
4. **Local exec is host execution** (`EXEC_SANDBOX=local`); development with trusted agents only. Production fails closed unless explicitly overridden.
5. **No velocity or period cap** on transfers; budget floor and four-eyes remain opt-in.
6. **Id keys outside the naming rules** (`memoryId`, `executionId`, `testRunId`) and **nested** object ids are not covered by the generic reference check.
7. **Cross-company social graph** (`relationship.*`) is intentionally open; whether to close it is a product decision.
8. **Phase 4 (Software Factory)** is unchanged: it still does not clone, write code or push. Building it needs the controlled push path and a human merge gate; not started, because the brief gates it on the above.

## Prioritized remaining work

1. Decide F5 (which tools are routine), then fix the risk table with tests.
2. Path TOCTOU hardening in `workspace.service.ts` plus a race test.
3. DNS pinning for webhooks/connectors, or documented egress filtering.
4. Review depth of recovery, shutdown and concurrency tests; add a crash/restart test for stuck tasks.
5. Transfer velocity cap (product decision).
6. Software Factory implementation (separate plan).

## Addendum: AW-28 (path guard, dangling symlinks)

| Id | Sev | Defect | Status |
|---|---|---|---|
| AW-28 | High | `resolveInRoot` used `existsSync`, which follows links, so a **dangling** symlink (or a path through one) looked like "does not exist yet". The guard approved the lexical path, and `fs.write` / `mkdirSync` then created the link's target wherever it pointed, e.g. outside the workspace. Deterministic, no race needed. Reachable by any code that can create a symlink in the workspace (agent commands; in Docker mode, the container). | Fixed: dangling symlinks are refused (`tests/workspace.test.ts`, failing before the fix) |

Verification: `npm test` 512 passed, 13 skipped (Docker suites; no daemon here); typecheck, lint, build, `check:docs` clean.

**Still open (not fixed):** the true check-then-use race (a symlink swapped in between `resolveInRoot` and the file operation) is not closed. Closing it needs per-segment `openat`/`O_NOFOLLOW` semantics that Node does not expose portably; the practical boundary remains the Docker sandbox. Treat `EXEC_SANDBOX=local` as trusted-agents-only.
