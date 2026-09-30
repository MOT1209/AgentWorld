# King World - Phase 1 Progress & Handover Plan

**Project:** AI Agent Company World - a simulated digital company where AI agents hold jobs, money, identities, memories and relationships.

**Phase 1 goal:** build the *core engine* that makes a Phase 2 city possible. Not a demo.

**Status of this document:** written at the end of the first working session. Everything under "Built" is on disk and typechecks. Everything under "Remaining" is not yet written.

---

## 1. Quick start (once the remaining work lands)

```bash
npm install
cp .env.example .env          # works as-is; no API keys needed
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev                   # API on :4000
npm run dev:web               # Dashboard on :5173
```

The system is designed to run **end to end with zero API keys** via the deterministic `mock` provider. Configure a real provider only when you want real model reasoning.

---

## 2. Architecture decisions (and why)

### Monorepo, single-pass TypeScript build
`/apps/{api,web}` + `/packages/*`, npm workspaces, ESM.

Cross-package imports are **relative with explicit `.js` extensions** (e.g. `../../shared/src/index.js`). This was chosen over `tsconfig` path aliases or project references because it makes runtime resolution correct after `tsc` emits into `dist/`, with zero build orchestration and no dual-config drift. `rootDir: "."` preserves the directory structure.

### Money is integer minor units, never a float
All amounts are `Int` minor units (cents) handled by the `Money` value object in `packages/shared/src/money.ts`. Currency is part of the value; mixing currencies throws. `MAX_MINOR` is enforced on every operation so overflow is impossible rather than silent.

**Known limit:** 2,147,483,647 minor units = 21,474,836.47 KW. Fine for Phase 1.
**Phase 2 path:** `BigInt` / Postgres `numeric(19,4)`. Only `Money` and the schema change.

### SQLite for Phase 1, with the portability cost stated up front
The SQLite Prisma connector has **no native `enum` and no `Json` scalar**. Therefore:
- enum-like columns are `String`, validated by Zod enums (`packages/shared/src/enums.ts`)
- structured payloads are `String` holding JSON, wrapped by `packages/shared/src/json.ts`

This is a deliberate trade for zero infrastructure. Moving to Postgres turns these into real `enum` + `jsonb`.

### The ledger is the only writer of balances
`packages/economy/src/ledger.service.ts` is the single code path that may touch `Wallet.balanceMinor`. Guarantees:
1. **Atomicity** - balance update + Transaction append in one DB transaction
2. **No overdraft** - a debit below zero is refused
3. **Double entry** - a transfer writes DEBIT + CREDIT legs sharing a `transferGroupId`
4. **Idempotency** - `idempotencyKey` turns a retry into a no-op (unique index backed)
5. **Immutability** - SQLite triggers abort any `UPDATE`/`DELETE` on `Transaction`
6. **Optimistic locking** - each write asserts the wallet `version`; two concurrent debits cannot both read the same balance
7. **Deterministic lock order** - two-wallet ops sort wallet ids, so deadlock is impossible

`verifyLedger()` replays the whole ledger and proves every stored balance equals the sum of its entries. It is called from the tests.

### Agents are configured, never hard-coded
There is **no `if (agent.name === ...)` anywhere in the repository**. Behaviour comes from `roleKey` -> `RoleProfile` (`packages/agents/src/role-profiles.ts`): prompt fragments, behavioural rules, permission grant, tool allow-list.

Four roles ship: `PLANNER`, `EXECUTOR`, `REVIEWER`, `ANALYST`. Adding a role is one entry.

The registry **refuses to load** a role that grants any human-only permission. That is the structural reason an agent cannot approve its own spend or widen its own authority.

### Agents can only act through tools
The runtime (`packages/agents/src/runtime.ts`) holds **no database handle and imports no services**. Its only capability is the injected `ToolInvoker`. Every effect passes through `ToolExecutor`, which enforces in order: lookup -> audience (humanOnly/agentOnly) -> permission -> Zod validation -> approval -> execution -> audit.

`ToolInvocation` rows are written for **every** outcome, including denials.

### The AI provider layer is genuinely swappable
`AIProvider` interface with adapters for OpenAI-compatible (which also covers Groq/OpenRouter/Together/LM Studio/vLLM/Ollama), Anthropic-compatible, Google, and a deterministic `mock`. Agents reference `providerId` as a column. Changing vendor is an `UPDATE`, not a deployment.

The `mock` provider is a **scripted stand-in, not an AI**, and says so in its own descriptor. It exists so the whole loop - tools, permissions, approvals, ledger, events, memory - is exercisable offline and in CI.

### Recipients are addressed by role, not name
`message.send({to: "EXECUTOR"})` resolves to whoever holds that role today. Replacing an agent through the Agent Factory does not break any caller's addressing logic.

### Two clocks, deliberately separate
- **Wall clock** - security (token expiry, rate limits), audit ordering. Not forgeable by advancing the simulation.
- **Simulation clock** - derived from persisted `timeOffsetMinutes` x `timeScale`. Agents think and rest in this clock; money and permissions do not.

This is what stops "fast-forward the day" from also fast-forwarding an approval window.

---

## 3. What is BUILT (on disk, `tsc --noEmit` clean)

### Database
`database/schema.prisma` - 27 models with foreign keys and indexes:

`User` `Company` `Department` `CompanyMember` `World` `City` `Location` `Agent` `AgentState` `AgentStateHistory` `AgentMemory` `AgentRelationship` `Project` `Task` `TaskDependency` `Conversation` `ConversationParticipant` `Message` `Wallet` `Transaction` `ApprovalRequest` `AgentBlueprint` `EventLog` `ActivityLog` `ToolInvocation`

Migrations applied:
- `20260930191421_init` - full schema
- `20260930200000_ledger_immutability` - SQLite triggers making `Transaction` append-only

### packages/shared
`enums.ts` (single source of truth for every enum-like value) - `money.ts` (integer-only value object) - `errors.ts` (AppError + HTTP mapping) - `json.ts` - `config.ts` (fail-fast in production) - `logger.ts` (structured JSON, secret redaction by key name) - `correlation.ts` - `time.ts` (dual clock) - `pagination.ts` - `slug.ts` - `actor.ts`

### packages/database
`client.ts` (singleton + health) - `transaction.ts` (retry on SQLITE_BUSY and optimistic-lock contention) - `types.ts`

### packages/security
`permissions.ts` (catalogue + `HUMAN_ONLY_PERMISSIONS`) - `rbac.ts` (OWNER/ADMIN/OBSERVER) - `password.ts` (bcrypt, cost clamped to >=10) - `tokens.ts` (HS256 pinned, issuer+audience verified, algorithm allow-list) - `rate-limit.ts` - `sanitize.ts` (log-injection stripping, length bounds, role-impersonation detection)

### packages/events
`catalog.ts` (typed event map, ~45 event types) - `bus.ts` (persist in the caller's transaction + failure-isolated fan-out) - `audit.ts` (ActivityLog; denials recorded as carefully as successes)

### packages/ai
`types.ts` - `json-schema.ts` (Zod -> JSON Schema, no extra dependency) - `http.ts` (timeout, secret redaction in provider errors) - 4 providers - `registry.ts`

### packages/economy
`wallet.service.ts` - `ledger.service.ts` (the single writer) - `statements.ts` (statements, totals, `verifyLedger`) - `treasury.service.ts`

### packages/company, packages/world, packages/tasks, packages/memory
- company: create/overview/departments/members/projects/`findAgentsByRole`
- world: World/City/Location CRUD, `moveAgent`, `tickWorld`, `getWorldSnapshot`, dual-clock helpers
- tasks: explicit transition table, dependency cycle detection, creator/assignee authorization, `getTaskDetail`, `getNextAvailableTask`
- memory: 4 kinds with distinct decay half-lives, weighted importance+recency ranking, expiry, `formatMemoriesForPrompt`

### packages/approvals
`approval-policy.ts` (ALWAYS_APPROVE / ROUTINE / ACTION_RISK tables, `evaluateApproval`, `requiresHumanApproval`) - `approval.service.ts` (immutable payload, single-flight `claimForExecution`, expiry sweep)

### packages/agents
`role-profiles.ts` (4 roles, validated registry) - `agent.service.ts` (CRUD, state + history, `buildRuntimeProfile`) - `communication.service.ts` (conversations, messages, role-based `resolveRecipient`) - `prompt-builder.ts` (system prompt + situational context) - `runtime.ts` (the think-act-observe loop) - `blueprints.ts` (Agent Factory: blueprint + approval; instantiation is human-only)

### packages/tools
`registry.ts` (validates every tool's static contract at boot) - `executor.ts` (the single enforcement point) - 17 built-in tools:
`task.create` `task.update` `task.list` `task.detail` `message.send` `message.read` `memory.store` `memory.search` `memory.forget` `wallet.balance` `wallet.transfer` `wallet.statement` `world.get_state` `world.get_location` `company.info` `event.emit` `approval.list` `approval.get` `approval.decide` (human-only)

### Toolchain
`package.json` (scripts incl. `verify`), `tsconfig.json` (strict + `noUncheckedIndexedAccess`), `eslint.config.js` (typescript-eslint, `no-explicit-any` = error), `vitest.config.ts`, `.env.example`, `.gitignore`, `scripts/normalize-encoding.mjs`

---

## 4. Remaining work

### 4.1 `apps/api` - the HTTP layer (NOT STARTED)
This is the largest remaining piece. Structure to build:

```
apps/api/src/
  main.ts               server bootstrap + graceful shutdown
  app.ts                express app assembly (so tests can import without listening)
  config/routes.ts      /api/v1 route table
  middleware/
    authenticate.ts     JWT -> req.principal
    require-permission.ts
    rate-limit.ts
    correlation.ts      inbound x-correlation-id -> req.correlationId
    error-handler.ts    AppError -> JSON response; never leaks internals
    validate.ts         zod body/query validation
  routes/
    auth.routes.ts      POST /auth/login, GET /auth/me
    world.routes.ts     world snapshot, tick, cities, locations
    company.routes.ts   overview, members, departments, projects
    agent.routes.ts     list, detail, state, provider change, run, chat
    task.routes.ts      CRUD, assign, transitions, dependencies
    conversation.routes.ts  list, detail, messages, send
    memory.routes.ts    per-agent memories
    economy.routes.ts   wallets, statements, transfers, treasury
    approval.routes.ts  list, detail, decide (+ replay on approve)
    tool.routes.ts      catalogue (dev/owner only)
    event.routes.ts     event log, activity log
  services/
    composition-root.ts wires ToolRegistry + ToolExecutor + registry
    agent-orchestrator.ts  runs runAgent for a chat turn
    approval-replay.ts     re-invokes a withheld tool after approval
  dto/                 response mappers (never leak provider secrets)
```

**Composition root is the key wiring point:**
```ts
export const toolRegistry = createDefaultRegistry();
export const toolExecutor = new ToolExecutor({ registry: toolRegistry });
export const invoker: ToolInvoker = {
  listSpecs: (perms, allowed) => toolExecutor.listSpecs(perms, allowed),
  invoke:   (name, args, ctx)  => toolExecutor.invoke(name, args, ctx),
};
```

**Approval replay:** on `POST /approvals/:id/decision {APPROVED}`, call
`claimForExecution(db, id)` (atomic single-flight), read the frozen payload with
`readApprovalPayload`, then `toolExecutor.invoke(toolName, arguments, {..., isApprovalReplay: true, approvalRequestId: id})`, then
`markExecutionSucceeded` / `markExecutionFailed`.

**Agent-to-agent wakeup:** subscribe to `EVENT_TYPES.MESSAGE_SENT` at bootstrap and run the recipient agent when a human message arrives in a single-participant thread. Add `notifyAgentId` to the `MESSAGE_SENT` payload in `packages/events/src/catalog.ts` and populate it in `sendMessage` (already computed there, just not yet in the payload).

### 4.2 `database/seed.ts` (NOT STARTED)
Must create, in dependency order:
1. Owner user from `SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD` (bcrypt), owner wallet
2. World "King World" (timeScale 60), City "King City"
3. Locations: King AI Corporation HQ (HQ), Central Bank (BANK), Central Market (MARKET)
4. Company "King AI Corporation" owned by the user
5. **Ahmad** - roleKey `PLANNER`, providerId from `DEFAULT_PROVIDER`
6. **Rashid** - roleKey `EXECUTOR`, providerId from `DEFAULT_PROVIDER`
7. Departments (e.g. Strategy, Operations), memberships with salaries
8. Wallets for both agents; fund company treasury via real `deposit` (not a direct balance write)
9. Sample conversation, sample tasks (one completed, one assigned), agent memories
10. A pending approval request so the Approvals screen is not empty

Make it idempotent: upsert by natural keys so `npm run db:seed` can be re-run.

### 4.3 `tests/` (NOT STARTED)
`tests/setup.ts` must **recreate the test database from migrations** (delete file, `prisma migrate deploy`). Reason: the `Transaction` immutability triggers make `deleteMany` impossible, so tests need a fresh DB rather than truncation. Consider a separate `TEST_DATABASE_URL`.

Required coverage (from the spec):
- Agent creation, state transitions + history
- Agent communication (human->agent, agent->agent by role)
- Task create / assign / complete; **illegal transitions rejected**; dependency cycle rejected; unmet dependency blocks start
- Memory store / retrieve / ranking / expiry / cross-agent isolation
- Wallet, transactions, transfers
- **Finance edge cases (the important ones):**
  - insufficient funds refused
  - balance never negative
  - transfer conservation (sum of both wallets unchanged)
  - idempotency key replay does not double-charge
  - concurrent transfers from one wallet cannot double-spend
  - `verifyLedger()` clean after a mixed sequence
  - `Transaction` UPDATE and DELETE rejected by trigger
  - same-wallet transfer rejected; currency mismatch rejected
- Company, world, events, approvals, permissions
- AI provider abstraction (mock determinism; provider selection swap)
- Tool permissions: denied without permission; humanOnly refused for agents; agentOnly refused for humans; Zod validation rejects bad args; approval gate holds a large transfer
- Role registry rejects human-only permission grants
- Integration: auth -> chat -> task created -> executor run -> report back

### 4.4 `apps/web` dashboard (NOT STARTED)
React + Vite + Tailwind. Sections per spec: World, Company, Agents, Tasks, Communication, Economy, Approvals, Activity.

The conversation view must visually distinguish **human messages / agent messages / system events / tool calls / task results** (the `kind` field already carries this).

Keep `VITE_API_BASE_URL` public-only; the token goes in memory or `sessionStorage`, never a build-time var.

### 4.5 `docs/` (NOT STARTED)
`ARCHITECTURE.md` (incl. the DB portability section referenced from the schema header) - `SECURITY.md` (threat model, permission matrix, approval policy) - `API.md` - `ROADMAP.md` (Phase 2 city plan).

---

## 5. Known issues / gotchas to carry forward

1. **`npm 11` blocks install scripts.** Prisma engines and esbuild need explicit approval:
   `npm approve-scripts prisma`, `npm approve-scripts @prisma/client`, `npm approve-scripts @prisma/engines`, `npm approve-scripts esbuild`.
2. **Windows encoding.** PowerShell wrote CP1252 for typographic characters and a UTF-8 BOM for `package.json` files. `scripts/normalize-encoding.mjs` repairs both and enforces ASCII-only. **Run it after any bulk edit made from PowerShell.** All source is intentionally ASCII.
3. **`toJsonArray` is for reads, `JSON.stringify` for writes.** Confusing them produced real type errors in `agent.service.ts`. The helper names are easy to misread.
4. **`Object.keys(...)` / sibling `OR` in one Prisma `where` overwrite each other.** Optional OR-groups must be nested under `AND` (see `retrieveMemories`).
5. **Transaction rollback + the `Transaction` delete trigger.** Hard-deleting a wallet that has transactions will fail. Wallets are retired with `isFrozen = 1`, which is correct accounting anyway.
6. **`message.send` self-filter.** An agent addressing a role it alone holds gets an explicit "no recipient other than yourself" error rather than a silent self-thread.
7. **Mock provider heuristics.** It keys off the system prompt text (`/delegate|plan|break down|analyse/`) and available tool names. If a role's prompt or tool list changes, its mock behaviour changes. That is expected - it is a stub, and a real provider is the answer.

---

## 6. Definition of Done - current status

| Item | Status |
|---|---|
| Monorepo + toolchain + config | DONE |
| Database schema + migrations | DONE |
| Ledger with audit guarantees | DONE |
| Event bus + audit log | DONE |
| AI provider abstraction | DONE |
| Security: auth, RBAC, permissions, sanitisation | DONE |
| Task engine + state machine | DONE |
| Memory engine | DONE |
| World / clock | DONE |
| Agent runtime + role profiles | DONE |
| Tool registry + executor + 17 tools | DONE |
| Approval policy + service | DONE |
| HTTP API | **TODO** |
| Seed data | **TODO** |
| Tests | **TODO** |
| Dashboard | **TODO** |
| Docs | **TODO** |
| Lint clean | **TODO** |
| Build passes | **TODO** |
| End-to-end verification | **TODO** |

**Verification command once the remaining work lands:** `npm run verify`
(typecheck -> lint -> test -> build).

---

## 7. Next session - suggested order

1. `apps/api` app assembly + middleware + `auth.routes.ts`, then verify login with curl
2. `database/seed.ts` - get real data into the database
3. `tests/setup.ts` + the finance test suite first (highest risk area)
4. Remaining API routes
5. Approvals replay wiring + agent-to-agent wakeup
6. `apps/web`
7. `docs/`
8. `npm run verify`, then the Phase 1 checklist
