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
  that looks like a secret is dropped even if declared.
- **Bounded.** Timeout, output cap, concurrency cap, bounded retries (TRANSIENT
  only). Cancellation kills the whole process tree (`taskkill /T` on Windows,
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

## Approval policy

`evaluateApproval` combines action risk, declared risk, and spend threshold
(`APPROVAL_SPEND_THRESHOLD` major units). Large `wallet.transfer` calls become
`PENDING_APPROVAL` with frozen arguments; approval replays them exactly once.

## Operational notes

- `npm 11` blocks install scripts: approve `prisma`, `@prisma/client`,
  `@prisma/engines`, `esbuild` explicitly.
- Prisma CLI hangs in some environments; `tests/setup.ts` applies migration
  SQL through the query engine instead of `migrate deploy`.
- Run `scripts/normalize-encoding.mjs` after bulk PowerShell edits.
