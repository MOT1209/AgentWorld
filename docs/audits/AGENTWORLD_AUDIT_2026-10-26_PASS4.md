# AgentWorld — Security audit, fourth pass (2026-10-26)

Continues [AGENTWORLD_AUDIT_2026-10-12_PASS3.md](AGENTWORLD_AUDIT_2026-10-12_PASS3.md)
(AW-24…AW-27). Base: `origin/main` at `1d0a6ff`. This pass re-checked the
places the earlier passes named as limits: id keys that do not follow the
naming rules, REST routes whose ids are not company links (CLAUDE.md: wallets
need an explicit check), and the test infrastructure. Each defect below was
reproduced with a failing test before the fix (`tests/audit4-agent-scope.test.ts`,
`tests/audit4-rest-scope.test.ts`, `tests/setup-drop-list.test.ts`).

## Baseline (before any change)

| Check | Result |
|---|---|
| `npm run typecheck` / `lint` / `check:docs` | clean |
| `npm test` | 510 passed, 13 skipped (Docker sandbox and OpenCode suites: no Docker daemon in this environment) |
| `npm run build` | clean |

> **CI note.** The `npm audit --omit=dev --audit-level=high` gate went red on main after this audit's baseline, for two
> advisories published in between: `body-parser < 1.20.9` and `zod < 4.6.6` (no patched 3.x). They are fixed in this PR by
> bumping `body-parser` and upgrading to `zod` 4 (the tool-schema converter now uses `z.toJSONSchema`), so the gate is green
> again; they are not findings of this audit.

## Confirmed defects

| Id | Sev | Defect | Status |
|---|---|---|---|
| AW-28 | High | Task `dependsOn` ids were never scoped. The key matches none of the id-key rules, and `addDependencies` only checked that the task existed. A company-scoped user (`POST /tasks`, `POST /tasks/:id/dependencies`) or an agent (`task.create`) could link its task to another company's task. `GET /tasks/:id` then showed that task's title and status, and the foreign task's own detail listed the caller's task. A refused `dependsOn` in `createTask` also left the new task behind. | Fixed: a dependency must be in the task's own company or the shared world (404 otherwise), checked before the task is inserted |
| AW-29 | High | `factory.get`, `factory.project`, `factory.advance` and `factory.team.suggest` took `factoryRunId` from model output, and `testing.get` and `testing.settle` took `testRunId`, all with no company check. `factory.list` and `testing.list` listed every company's runs. Agent roles hold `FACTORY_READ`, `TESTING_READ` and (QA) `TESTING_RUN`, so an agent could read other companies' runs and rewrite a foreign test run's verdict. | Fixed: `factoryRunId`, `testRunId`, `trainingRunId` and `executionId` are indirect links in the shared reference check (executor step 4b and REST `scopeRefs`); both lists are scoped to the agent's company |
| AW-30 | Low (latent) | Economy routes `/transfer`, `/deposit`, `/withdraw` and `/wallets/:id/freeze` acted on any wallet id. `/wallets/ensure` minted a wallet for an owner id that does not exist (the REST twin of AW-25). Not exploitable with the current roles, because only the platform OWNER (who sees every company) holds `WALLET_TRANSFER`/`WALLET_WITHDRAW`. It becomes exploitable the day either permission is granted to ADMIN. | Fixed: `requireVisibleWallet` and `assertWalletOwnerVisible` (`company-access.ts`) |
| AW-31 | Low | `GET /skills/:key/usage` returned the ids of every company's agents that use the skill. `POST /skills/requests/:id/decision` let a company-scoped ADMIN decide another company's agent's request. | Fixed: agent ids filtered by scope; a foreign request is a 404 |
| AW-32 | Low | The OAuth `state` HMAC key fell back to the public constant `"dev-oauth-state"` when `VAULT_MASTER_KEY` was empty, in production too. Forging a state was mitigated in practice, because sealing the token then fails in the vault. The signature check itself was still meaningless. | Fixed: production refuses, matching the vault |
| AW-33 | Low (test infra) | The DROP list in `tests/setup.ts` lacked `CompanyAccess` and `OAuthState`. When a leftover test database cannot be deleted (Windows locks), the migration replay fails with "table already exists". This was not reproduced on Linux, where the file is always deleted. | Fixed, plus a guard test comparing migrations with the list |

## Fixes (files)

- `packages/tasks/src/task.service.ts`: `requireDependencyFor`, used by `createTask` (before the insert) and `addDependencies`.
- `packages/security/src/company-refs.ts`: four new indirect links.
- `packages/tools/src/definitions/factory-tools.ts`, `testing-tools.ts`: lists scoped for agent callers.
- `packages/security/src/company-access.ts`: `requireVisibleWallet`, `assertWalletOwnerVisible`; used by `apps/api/src/routes/economy.routes.ts`.
- `apps/api/src/routes/skill.routes.ts`: usage and decision scoping.
- `packages/connectors/src/oauth.ts`: `stateSecret()` refuses the fallback in production.
- `tests/setup.ts`: DROP list.
- Docs: `docs/SECURITY.md`, `CHANGELOG.md`.

## Final verification

| Check | Result |
|---|---|
| `npm run typecheck` / `lint` / `check:docs` | clean |
| `npm test` (after `rm -rf workspaces`) | 528 passed, 13 skipped, 0 failed (510 before + 18 new) |
| `npm run build` | clean |

Skipped, environment-dependent: the Docker sandbox suites and the OpenCode
smoke test (no Docker daemon in this session). They were **not** run here.

## Reviewed and found sound (not changed)

- `scopeParam` / router `param` hooks: every router with `:id` routes resolves
  the row's company before the handler (task, company, economy treasury, and
  the scoped routers).
- `command-policy.ts`: argv-only execution; inline-code flags, `git -c`,
  `find -exec`, out-of-workspace paths and reserved env keys are held or
  stripped as documented.
- `Money`: decimal-string parsing and a safe-integer range check; the REST
  amount regex allows two decimals only.
- Error handler: non-operational errors return a generic message plus the
  correlation id.
- Webhook signatures are HMAC-SHA256 over `timestamp.body`; OAuth state uses a
  constant-time compare.
- Dashboard: the token lives in `sessionStorage`, and there is no
  `dangerouslySetInnerHTML`.

## Observations (no code change)

1. **Package installs vs. fetch-and-run.** `npx`, `npm exec` and `git fetch`/`clone`
   are held for approval as network-reaching, yet `npm install <pkg>` and
   `pip install <pkg>` are ALLOW and also fetch and run third-party code
   (install scripts). Egress belongs to the sandbox's network policy, so which
   way to make it consistent is a product decision.
2. **`FactoryView.tsx:225`** renders `href={pullRequest.url}` without checking
   the scheme. The URL comes from the GitHub API, not from agents, so the risk
   is low. A scheme allow-list (`https:`) would close it.

## Not covered by this pass

The web dashboard beyond the XSS and token-storage checks, deployment files
(`Dockerfile`, `docker-compose.yml`, CI) and the doc-to-code drift beyond
`check:docs` were only skimmed. This report does **not** claim them verified.

## Remaining risks and open items

From pass 3, still open: F5 (approval risk table), DNS rebinding, path
TOCTOU, local exec is host execution, no transfer velocity cap, the
intentionally open `relationship.*` graph, and Software Factory phase 4.
In addition:

1. Nested ids inside objects are still not scanned by the generic reference
   check (top-level keys only, same as REST).
2. Dependency rows created before this fix may still link two companies. A
   one-off query (`TaskDependency` joined to `Task` on both ends where the
   companies differ) finds them.
3. The two observations above.
