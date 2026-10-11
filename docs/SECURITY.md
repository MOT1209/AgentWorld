# King World — Security

## Threat model

- Untrusted model output: every tool call is validated (Zod), authorised
  (permission), and gated (approval) before execution. The model cannot bypass
  schema validation by emitting the right shape.
- Privilege escalation: agents hold role-derived permissions only. The role
  registry refuses human-only grants at load time. `approval.decide`,
  `agent.create/delete/modify`, `company.structure.modify`, `audit.read`, and
  `wallet.withdraw` are human-only.
- Double spend: optimistic locking (`version`) + unique `idempotencyKey` +
  single-flight approval claims.
- History rewriting: `Transaction` is append-only via SQLite triggers; wallets
  retire with `isFrozen`, never hard delete.
- Secret leakage: DTOs never serialise `passwordHash` or provider keys. Logs
  redact by key name. `VITE_*` vars are public by definition — the token lives
  in `sessionStorage`, never in build output.
- Token forgery: HS256 pinned with algorithm allow-list, issuer + audience
  verified. Missing/weak `JWT_SECRET` is fatal in production.
- Brute force: login (10/15min) and agent-run (20/min) rate limits.
- Log injection: inputs are sanitised (CRLF collapsed, length-bounded) and
  role-impersonation patterns are flagged.

## Permission matrix

| Capability | OBSERVER | ADMIN | OWNER |
|---|---|---|---|
| Read world/company/agents/tasks/messages | yes | yes | yes |
| Run agents, chat | yes | yes | yes |
| Write world/company, modify agents | no | yes | yes |
| Assign/complete/cancel tasks, decide approvals | no | yes | yes |
| Modify company structure, delete agents | no | no | yes |
| Transfer/withdraw money, read audit | no | no | yes |

### Company scope (visibility)

Roles decide what a user may *do*; company scope decides which companies they
may *see* (`packages/security/src/company-access.ts`). A platform `OWNER`
sees every company. Anyone else sees the companies they own plus those
granted via `CompanyAccess` (`POST/DELETE /companies/:id/access`, managed by
the company owner or a platform owner). An invisible company answers 404.
Rows with no company (shared world, unaffiliated agents) stay visible.

Enforcement (`apps/api/src/middleware/company-scope.ts`):

- Every authenticated router runs `scopeRefs`: any company, agent
  (`agentId`, `*AgentId`), task, plan or workspace id in the body or query
  string must be visible, so work cannot be filed into, assigned from, or
  filtered by another company.
- `:id`-style params resolve their row's links (company directly, or via its
  agent's current company, task, plan, or workspace agent); a row is visible
  only when every link is.
- Lists are filtered the same way (they can return fewer rows than `take`).
- Event log, activity log and the SSE stream filter by actor and target;
  non-owners never see other users' IP or user agent. The stream resolves
  scope once per connection, so a grant change applies on reconnect.
- `/economy/totals`, `/economy/verify`, and the global pending-approval
  count are platform-owner figures.
- API keys (MCP) act with platform-wide visibility, so they only work while
  their owner is an active platform `OWNER`.

Platform-level by design (no company): world/city/locations and the
simulation clock, skills, tool catalogue, providers/models, credentials and
API-key metadata. Visibility follows an agent's *current* company.

Agent tools declare `requiredPermission` + `risk`; anything `HIGH`/`CRITICAL`
or on the always-approve list (`agent.create`, `wallet.withdraw`, …) is
withheld pending a human.

## Execution runtime (Phase 3)

- **One gate for every job.** `enqueueExecution` is the only creation path
  (REST, tools, verification). It requires a usable workspace for any
  non-mock backend, forces the working directory inside the workspace root
  (relative, absolute, drive and UNC forms rejected; the realpath of the
  longest existing ancestor is checked, so a not-yet-created file under a
  symlink or a nested symlink chain cannot escape), and runs CommandPolicy.
  DENY is always refused; REQUIRE_APPROVAL is refused unless the approval flow
  cleared it, so the REST API cannot clear approvals. The runner re-checks DENY
  and the working directory right before spawning, so a row written around the
  gate still cannot run.
- **No shell.** Commands are argv arrays spawned with `shell: false`; shell
  metacharacters are inert data. Unknown commands, inline-code interpreters and
  arguments pointing outside the workspace require approval.
- **Environment allow-list.** Child processes get a fixed allow-list; any key
  that looks like a secret is dropped even if declared. Both command runners
  (local and Docker) strip secret-named variables again right before spawning,
  whoever built the environment.
- **No unsandboxed production by accident.** `EXEC_SANDBOX` defaults to
  `docker` in production. `EXEC_SANDBOX=local` with `NODE_ENV=production`
  refuses to boot unless `EXEC_ALLOW_UNSANDBOXED_PRODUCTION=true` is set, and
  the runner re-checks it, so no code path obtains the host runner silently.
  Docker problems are error results, never a fallback to the host. See
  `docs/SANDBOX.md`.
- **Bounded.** Timeout, output cap, concurrency cap (queue worker, plus
  `EXEC_MAX_CONCURRENT` live agent processes per API process across
  `terminal.*`, `git.*` and jobs), bounded retries (TRANSIENT only). Cancellation kills the whole process tree (`taskkill /T` on Windows,
  process group on POSIX).
- **Isolation.** `terminal.*` and `execution.*` answer "not found" for another
  workspace's processes and jobs, so ids cannot be probed. Artifacts store
  root-relative paths, re-validated on registration; rows hold no contents.
- **OpenCode is a backend, not an AI provider.** It receives the workspace and
  an approved prompt, never secrets or policy; prompt-driven runs always need
  human approval. The binary is named only in
  `packages/execution/src/backends/opencode.ts` and `OPENCODE_COMMAND`.
- **Recovery.** Jobs left RUNNING by a crash are requeued (attempts left) or
  failed (`SYSTEM`) at worker start and by a periodic sweep.

Tests: `tests/security-m4.test.ts`, `tests/execution-tools-m1.test.ts`,
`tests/execution-m2.test.ts`, `tests/execution-tools.test.ts`.

## MCP server (`packages/mcp/src/server.ts`)

- **Order of checks per `tools/call`:** API key -> tool lookup -> key scope ->
  argument validation -> `run`. Nothing reaches the database before all four
  pass; scope is checked first, so arguments can never widen authority.
- **One schema per tool.** Each tool declares a strict zod schema; the
  `inputSchema` returned by `tools/list` is generated from it, and the same
  schema validates `arguments`. Unknown fields, wrong types, out-of-enum values
  and over-long strings are rejected with JSON-RPC `-32602` (issues listed by
  path, submitted values never echoed). Serialized arguments are capped at
  64 KB; the HTTP body is capped at 256 KB.
- **Same services as REST.** State-changing tools call Core services
  (`tasks.create` -> `createTask`, `testing.run` -> `runTestSuite`), so
  business rules, `TASK_CREATED` events and `task.create` activity rows are
  identical on both paths. Read tools select explicit public fields only.
- **Errors.** Expected business failures (not found, invalid state) return an
  MCP tool result with `isError: true`. Anything unexpected is logged with a
  correlation id and answered with `-32603 "Internal error"` carrying only that
  id: no stack traces, SQL, file paths or secrets. Scope denials, unknown tools
  and invalid arguments are audited as `MCP_DENIED`.
- **Residual:** `tasks.create` has no idempotency key (neither does REST), so a
  client that retries after a lost response can create a duplicate task.

## External skills (`/api/v1/skills`)

- Catalog, assignments, usage counters and agent skill requests are stored in
  the database (`SkillCatalogEntry`, `SkillAssignment`, `SkillUsage`,
  `SkillUsageAgent`, `SkillRequest`); nothing is lost on restart. Assignments
  are unique per (skill, agent); counters move by atomic increments; a skill
  request can be decided once (compare-and-set). A corrupt catalog row fails
  loudly and is never overwritten.
- Skill approvals (`skill.install`, `skill.update`, `skill.assign`) are bound
  to their exact target (external id + manifest key/version, skill key +
  versions, skill key + agent) and are single-use: an approval granted for one
  agent or version cannot unlock another, and cannot be replayed.
- Rows hold the normalized manifest (secret requirement *names* only) and
  integrity hashes, never skill file contents or secret values.

## Approval policy

`evaluateApproval` combines action risk, declared risk, and spend threshold
(`APPROVAL_SPEND_THRESHOLD` major units). Large `wallet.transfer` calls become
`PENDING_APPROVAL` with frozen arguments; approval replays them exactly once.

## Outbound requests (SSRF)

URLs a caller chooses (webhook subscriptions, the `graphql` endpoint and
`webhook-out` url an agent passes) go through `assertPublicUrl`
(`packages/shared/src/net.ts`) in production: the host is resolved and every
address must be public unicast (no loopback, RFC 1918, link-local/metadata,
CGNAT, ULA, or IPv4-mapped/NAT64 spellings of those). Webhooks are re-checked
at each delivery, and these requests never follow redirects. A `graphql`
credential's token is only sent to its configured base-URL origin.
Residual: fetch resolves DNS again, so a rebinding host with a ~0s TTL can
still race the check; egress filtering at the network layer closes that.

## Sessions in URLs and OAuth state

- The SSE stream never takes the access token in a URL: browsers use a
  60-second, stream-only ticket (`POST /events/ticket`, audience
  `kingworld-stream`) that cannot call the API.
- OAuth `state` is stored in the `OAuthState` table (single-use, 10-minute
  TTL), so callbacks work across instances and restarts.

## Error responses

REST: 4xx carry the operational message; an unexpected 500 returns only
`{ code: "INTERNAL_ERROR", message: "Internal server error", correlationId }`
-- the driver/ORM text stays in the server log. MCP: see above.

## Operational notes

- `npm 11` blocks install scripts: approve `prisma`, `@prisma/client`,
  `@prisma/engines`, `esbuild` explicitly.
- Prisma CLI hangs in some environments; `tests/setup.ts` applies migration
  SQL through the query engine instead of `migrate deploy`.
- Run `scripts/normalize-encoding.mjs` after bulk PowerShell edits.
