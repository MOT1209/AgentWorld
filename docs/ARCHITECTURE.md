# King World — Architecture

Phase 1 builds the core engine that makes a Phase 2 city possible.

## Monorepo

`apps/api` (Express REST), `apps/web` (React dashboard), `packages/*` (domain),
`database/` (Prisma + SQLite), `tests/` (vitest), `docs/`.

Cross-package imports are relative with explicit `.js` extensions. `rootDir: "."`
preserves emitted structure under `dist/`.

## Request path

`authenticate` (JWT -> principal) -> `require-permission` (RBAC) ->
`validate` (Zod) -> route handler -> service -> `recordActivity` + `eventBus`.

Every outcome, including denials, is persisted (`ToolInvocation`, `ActivityLog`).

## The ledger is the only writer of balances

`packages/economy/src/ledger.service.ts` owns `Wallet.balanceMinor`:

1. Atomicity — balance update + `Transaction` append in one DB transaction.
2. No overdraft — debits below zero are refused.
3. Double entry — transfers write DEBIT + CREDIT legs sharing `transferGroupId`.
4. Idempotency — `idempotencyKey` turns retries into no-ops (unique index).
5. Immutability — SQLite triggers abort `UPDATE`/`DELETE` on `Transaction`.
6. Optimistic locking — each write asserts wallet `version`.
7. Deterministic lock order — wallet ids are sorted before two-wallet ops.

`verifyLedger()` replays the ledger and proves stored balances equal entry sums.

## Agents act only through tools

The runtime holds no database handle. Its only capability is the injected
`ToolInvoker`. Every effect passes `ToolExecutor`: lookup -> audience
(humanOnly/agentOnly) -> permission -> Zod validation -> approval -> execution
-> audit.

## Roles, not names

Behaviour comes from `roleKey` -> `RoleProfile`. No `if (agent.name === ...)`
exists. The registry refuses roles granting human-only permissions, which is
the structural reason agents cannot approve their own spend.

## Recipients by role

`message.send({to: "EXECUTOR"})` resolves to whoever holds that role today.
Agent replacement via the Factory never breaks caller addressing.

## Two clocks

- Wall clock — security (token expiry, rate limits), audit ordering.
- Simulation clock — `simulatedNow = wallNow + timeOffsetMinutes`, advanced at
  `timeScale` x real time; agents think/rest here.

Advancing the simulation never extends an approval window.

## Simulation engine

`packages/simulation` owns world clock control, needs, skills, goals,
activities, the deterministic decision engine, the validated action system, and
the tick loop. A heartbeat ticks only a `RUNNING` world; each tick finishes due
activities, decays needs, and lets free agents decide. Every decision passes the
same `validateAction` gate as an operator action, so neither a rule nor a future
model can bypass the agent lifecycle. See `docs/SIMULATION_ENGINE.md`.

## AI providers

`AIProvider` interface + OpenAI-compatible, Anthropic-compatible, Google, and
deterministic `mock` adapters. Agents reference `providerId` as data. The
`mock` provider is a scripted stub, not AI, for offline end-to-end runs.

## Approval replay

On `APPROVED`, the API calls `claimForExecution` (atomic single-flight), reads
the frozen payload, re-invokes the tool with `isApprovalReplay: true`, then
marks success/failure. The agent never re-derives arguments.

## Agent-to-agent wakeup

`sendMessage` computes `notifyAgentId` (single-participant human threads) and
publishes it on `MESSAGE_SENT`. The API subscribes at bootstrap and runs the
recipient agent best-effort.

## Database portability

SQLite (Phase 1) has no native `enum` or `Json`: enum-like columns are `String`
validated by Zod (`packages/shared/src/enums.ts`), payloads are `String`
holding JSON (`packages/shared/src/json.ts`), money is `Int` minor units.
Phase 2 (Postgres): real `enum` + `jsonb` + `numeric(19,4)`. Only `Money` and
the schema change.

Known limit: `MAX_MINOR` 2,147,483,647 = 21,474,836.47 KW.
