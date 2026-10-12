# AgentWorld — Repository Audit, second pass (2026-10-12)

Continues [AGENTWORLD_AUDIT.md](AGENTWORLD_AUDIT.md) (2026-10-11, findings
AW-01…AW-19, merged via PR #16). This pass starts from `origin/main` at
`5c331ae` (also includes PR #17: AgentWorld naming / single-container
deploy / WAL / backups, and PR #15's skills+MCP+sandbox hardening).
Findings here continue the AW-NN numbering. Each defect below was
reproduced with a failing test before it was fixed; the tests live in
`tests/audit2-rbac-workspace.test.ts`.

## Baseline (before any change in this pass)

| Check | Result |
|---|---|
| `npm ci` | clean |
| `npm audit` (all + `--omit=dev`) | 0 vulnerabilities, both |
| `npm run typecheck` / `lint` / `check:docs` | clean |
| `npm test` (Docker available, `node:22-alpine` tagged as the sandbox image since the real `docker/sandbox` image could not be built here — Alpine package mirror blocked by the session's egress policy, same residual as the first pass) | 492 passed, 2 skipped (git-in-container, OpenCode) |
| `npm run build` | clean |

No regressions were introduced: the full suite is green after every fix in
this document (final count below).

## Confirmed defects

| Id | Sev | Defect | Evidence | Status |
|---|---|---|---|---|
| AW-20 | **Critical** | `OBSERVER_PERMISSIONS` (`packages/security/src/rbac.ts`) included `TESTING_RUN` and `FACTORY_RUN`, contradicting the class's own "Read-only for OBSERVER" doc comment and `docs/SECURITY.md`'s permission matrix (which lists only "Run agents, chat" for OBSERVER). `FACTORY_RUN` gates `POST /factory/runs` (start) and `POST /factory/runs/:id/approve`, which **merges a real pull request on an external GitHub repository** (`GithubClient.mergePullRequest`). `Company.ownerId` carries no role restriction, so an OBSERVER who merely owns a company could start a factory run and merge a PR end to end over REST. | `POST /factory/runs` as OBSERVER → `201 Created` (reproduced before fix) | **Fixed** |
| AW-21 | **High** | `testing.run`'s command adapter (`packages/factory/src/testing.ts`) delegates to the same execution queue as `terminal.exec`/`fs.*`/`git.*`, but — unlike every one of those — it never called `canWriteWorkspace`. Any agent holding `testing.run` (a common grant: the EXECUTOR role profile has it) could queue a command run inside **any workspace by id**, including one owned by a different agent or a different company's agent, bypassing the one ACL check every sibling tool enforces. The REST route (`apps/api/src/routes/testing.routes.ts`) had the identical gap: it is missing the `canWriteWorkspace` check that the otherwise-identical `/executions` route applies. | Agent tool invocation against another agent's workspace returned `SUCCESS` and queued an `ExecutionJob` (reproduced before fix, by reverting only the fix commit) | **Fixed** |
| AW-22 | **High** | `workspace.create` (`packages/tools/src/definitions/workspace-tools.ts`) accepted an `agentId` argument that **overrode** the calling agent's own id with no relationship check. Any agent holding `workspace.write` could create a new workspace permanently attributed to **any other agent in the system, including one in a different company**, polluting that agent's workspace list, company-scoped dashboard views, and shared disk/DB usage under its name. | `workspace.create({agentId: <other agent>})` from agent A produced a `Workspace` row with `agentId = <other agent>` (reproduced before fix) | **Fixed** |

## Fixes applied

1. **`packages/security/src/rbac.ts`** — removed `TESTING_RUN` and
   `FACTORY_RUN` from `OBSERVER_PERMISSIONS`. `ADMIN_PERMISSIONS` already
   lists both explicitly, so ADMIN and OWNER are unaffected.
2. **`packages/tools/src/definitions/testing-tools.ts`** — `testingRunTool`
   now resolves the named workspace and calls `canWriteWorkspace` (the exact
   helper `terminal.exec`/`fs.write`/`git.commit` already use) before
   queuing any run that names a workspace.
3. **`apps/api/src/routes/testing.routes.ts`** — `POST /testing/run` now
   performs the same `requireWorkspace` + `canWriteWorkspace` check
   `POST /executions` already performs, for the same reason.
4. **`packages/tools/src/definitions/workspace-tools.ts`** —
   `workspaceCreateTool` now ignores `input.agentId` when the caller is an
   agent (`context.agentId !== undefined`); an agent always creates a
   workspace for itself. The override is still honoured for a human/system
   caller provisioning a workspace on an agent's behalf (unchanged, and
   verified by a passing regression test).

All four fixes are minimal, mirror an established, working pattern already
used elsewhere in the same file family, and were each proven with a test
that failed on the original code and passes after the fix.

## Final verification

| Check | Result |
|---|---|
| `npm run typecheck` / `lint` / `check:docs` | clean |
| `npm test` | **498 passed, 2 skipped (500)**, after clearing stale `test-*.db` files left over from repeated runs in this session (`npm run db:clean:test`) — one unrelated flake ("there is already another table or index") was traced to that leftover state, confirmed by a clean rerun, and is not a product defect |
| `npm run build` | clean |

## Areas reviewed and found sound (no code change)

- **Credential vault** (`packages/vault/src`, new since the first pass):
  AES-256-GCM, scrypt-derived key, production requires an explicit
  `VAULT_MASTER_KEY` (refuses to seal/open otherwise), plaintext has exactly
  one read path (`revealCredential`), rate-limited, audited, revocation is
  terminal. Operational note (not a vulnerability): rotating the master key
  makes all previously-sealed secrets permanently unreadable — there is no
  migration tool. Worth a documented runbook before relying on rotation.
- **GitHub integration** (`packages/factory/src/github.ts`): pure REST API
  v3 calls (no shell/git CLI), strict owner/repo regex, `encodeURIComponent`
  on path segments, bounded timeouts, merge always gated behind
  `approveFactoryRun`'s own-stage check (only reachable from
  `AWAITING_APPROVAL`) — no command-injection surface at all.
- **Docker/CI hardening**: `.github/workflows/ci.yml` already runs with
  least-privilege `permissions: contents: read`, concurrency cancellation,
  and `npm audit --omit=dev --audit-level=high` as a blocking gate; the
  production `Dockerfile` runs as `USER node`, drops build-time secrets via
  `.dockerignore`, and the CI `docker` job boots the real production image
  and exercises `/ready`, `/health` and a real login. `EXEC_SANDBOX=local`
  in production fails closed unless `EXEC_ALLOW_UNSANDBOXED_PRODUCTION=true`
  is set explicitly (`packages/shared/src/config.ts`), and `docker-compose.yml`
  documents the trade-off rather than hiding it.
- **CSRF**: not applicable — the API is Bearer-token-only (`Authorization`
  header), no cookies are set anywhere, and CORS sends `credentials: false`.
- **Memory-as-prompt-injection** (Phase H): retrieved `AgentMemory` content
  is concatenated into the model's context unescaped
  (`formatMemoriesForPrompt`), which is a real, generic prompt-injection
  surface common to RAG-style systems. It cannot be meaningfully closed by
  sanitizing text. The system's actual mitigation is architectural and
  confirmed intact: every tool call the model might be talked into
  attempting still passes through the same permission/approval/workspace-ACL
  gate regardless of what "convinced" it, so a poisoned memory can make an
  agent *try* a privileged action but cannot make it *succeed*.
- **Action pinning** (Phase J): `actions/checkout@v4` and
  `actions/setup-node@v4` are tag-pinned, not SHA-pinned. Recommended
  hardening, **not applied**: this session's GitHub access is scoped to
  `MOT1209/AgentWorld` only, so the current commit SHA for each tag could
  not be verified against the upstream `actions/*` repos. Pinning to a
  guessed or unverified SHA risks breaking CI outright, which is worse than
  the (low) supply-chain risk of GitHub's own first-party actions. Left as
  a recommendation for whoever has broader access to verify the SHAs.
- **Economy tool identity checks** (`wallet.balance`'s `agentId` override):
  already restricted to `actorType === "USER"` only; an agent can never name
  another agent's wallet. (Also currently unreachable by any agent in
  practice, since no REST surface lets a human invoke a tool directly
  outside the approval-replay path, and `wallet.balance` is never held for
  approval.)

## Remaining risks (unchanged from the first pass, not re-litigated here)

See [AGENTWORLD_AUDIT.md §4](AGENTWORLD_AUDIT.md#4-remaining-risks-not-fixed):
local execution is host execution by design, workspace path-guard TOCTOU,
development-mode SSRF, and wallet/user ids not resolved by `scopeRefs`.
