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
