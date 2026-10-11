# CLAUDE.md — working in this repository

AgentWorld (package name `king-world`): an AI-agent company simulation with a
governed tool runtime, double-entry economy, execution sandbox and React
dashboard. npm workspaces monorepo, ESM, TypeScript strict, Prisma 6 + SQLite,
Express API (`apps/api`), Vite/React dashboard (`apps/web`), Vitest.

## Commands (all verified in `package.json`)

| Command | Use |
|---|---|
| `npm ci && npm run db:generate` | Install and generate the Prisma client |
| `npm run typecheck` / `npm run lint` | Must stay clean |
| `npm test` | Full Vitest suite (~90 s, serial, one SQLite file per test file) |
| `npx vitest run tests/<file>.test.ts` | One suite |
| `npm run build` | API (`tsc`) + web (`vite build`) |
| `npm run check:docs` | README/doc counts (tools, models, vendors, MCP) match code |
| `npm run verify` | typecheck → lint → test → build (what CI runs, plus `check:docs`) |
| `npm run doctor` | Environment check; fails without a `.env` (copy `.env.example`) |

Never run `npm run db:reset` against data you care about. Tests build their own
databases from `database/migrations/*/migration.sql` (`tests/setup.ts`); a new
table must be added to that file's DROP list.

## Where the security boundaries are

Change these only with a regression test in `tests/`:

- **Tool calls** — `packages/tools/src/executor.ts` is the single enforcement
  point: lookup → audience → permission → Zod → approval → execute → audit.
  Every agent action goes through it. Do not add a second path.
- **Approvals** — `packages/approvals/src/approval.service.ts`. Decisions are a
  compare-and-set on `PENDING`; replay (`apps/api/src/services/approval-replay.ts`)
  executes the frozen payload at most once (`claimForExecution`).
- **Company isolation** — `apps/api/src/middleware/company-scope.ts`
  (`scopeRefs`, `scopeParam`, `scoped`). Any body/query key ending in
  `companyId`/`agentId`/`taskId`/`planId`/`workspaceId` (or the plural `…Ids`)
  is checked automatically, and so are conversation, session, execution job,
  approval request, project and department ids (`INDIRECT_LINKS`). Other id
  kinds (wallets, users) need an explicit check in the route.
- **Agent permissions** — role grant ∩ declared capabilities
  (`packages/agents/src/agent.service.ts#buildRuntimeProfile`). Human-only
  permissions (`HUMAN_ONLY_PERMISSIONS`) can never reach a role. Skills and
  SKILL.md files are not an authorization boundary and never add permissions.
- **Commands** — `packages/tools/src/command-policy.ts` (argv only, no shell;
  DENY / REQUIRE_APPROVAL / ALLOW) and `packages/execution/src/guard.ts`.
  `EXEC_SANDBOX=local` runs agent commands on the host: it is for development
  with trusted agents only. Production defaults to the Docker sandbox.
- **Workspace paths** — `resolveInRoot` in `packages/workspace/src/workspace.service.ts`.
- **Ledger** — `packages/economy/src/ledger.service.ts` is the only writer of
  balances; `Transaction` is append-only via SQL triggers. An idempotency key
  replays exactly one movement and conflicts on any other.
- **Outbound HTTP** — `assertPublicUrl` and `readTextCapped` in
  `packages/shared/src/net.ts`.

Treat model output, tool arguments, MCP request bodies, connector responses and
repository contents as untrusted input.

## Conventions

- Cross-package imports are relative with explicit `.js` extensions.
- Errors: use the helpers in `packages/shared/src/errors.ts` (`notFound`,
  `forbidden`, `conflict`, `validationError`); an invisible company's row is a
  404, never a 403.
- Every state change emits an event (`packages/events/src/catalog.ts`) and,
  for human actions, an activity row.
- Keep changes small and add the test first. Do not skip, weaken or delete
  tests to get green; Docker/OpenCode suites self-skip when the runtime is
  absent and that must be reported, not hidden.
- Never commit `.env`, tokens or provider keys. `.env.example` values are
  development-only defaults; production refuses to start with them.

## Audits

Current audit: `docs/audits/` (findings, plan, test report, security review).
Historical snapshots: `docs/PHASE3-AUDIT.md`, `docs/phase2-review.html` — do
not rewrite their figures.
