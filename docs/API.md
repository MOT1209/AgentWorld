# King World — API

Base: `http://localhost:4000/api/v1`. Auth: `Authorization: Bearer <JWT>`.
Every response carries `correlationId`; errors are `{ code, message, correlationId }`.

## Auth

- `POST /auth/login {email, password}` -> `{ token, user }`
- `GET /auth/me` -> principal + permissions

## World

- `GET /world/snapshot?worldId=` — full snapshot (cities, locations, phase)
- `GET /world/time?worldId=` — simulated vs wall clock
- `POST /world/tick {worldId?}` — advance simulation (WORLD_WRITE)
- `GET /world/worlds`, `GET /world/cities?worldId=`, `GET /world/locations?worldId=&cityId=&kind=`
- `GET /world/locations/:id` — occupants included
- `POST /world/move-agent {agentId, toLocationId, reason?}`
- `POST /world/worlds|cities|locations` — create geography

## Simulation

- `GET /simulation/state?worldId=` — world status/clock, engine heartbeat, counts, per-agent state + needs
- `GET /simulation/clock?worldId=` — simulated vs wall clock
- `POST /simulation/start|pause|resume|stop {worldId?}` — world lifecycle (WORLD_WRITE)
- `POST /simulation/tick {worldId?}` — run one tick synchronously (WORLD_WRITE)
- `POST /simulation/speed {timeScale, worldId?}` — 0.1x..10000x (WORLD_WRITE)

## Event stream

- `GET /events/stream?token=<JWT>&worldId=&companyId=&type=` — Server-Sent
  Events (`text/event-stream`). EventSource cannot set headers, so the token may
  be passed as a query parameter; `event.read` is required. Each message is
  `id: <EventLog.id>`, `event: <TYPE>`, `data: <persisted event JSON>`; a
  `connected` event and periodic `: heartbeat` comments keep the stream open.

## Companies

- `GET /companies`, `POST /companies {name, description?}`
- `GET /companies/:id`, `GET /companies/:id/overview|members|departments|projects|agents`
- `POST /companies/:id/departments|members|projects`

## Agents

- `GET /agents?companyId=&roleKey=` — list
- `POST /agents` — create (AGENT_CREATE)
- `GET /agents/:id`, `PATCH /agents/:id`, `GET /agents/:id/profile`
- `GET|POST /agents/:id/state`
- `POST /agents/:id/provider {providerId, model, temperature?}` — vendor swap as data
- `POST /agents/:id/run {trigger, conversationId?, taskId?, userMessage?}`
- `POST /agents/:id/chat {content, companyId?}` — direct thread + run
- `GET /agents/:id/activity` — the single open activity + recent history
- `GET /agents/:id/needs` — parsed vitals (0..100, higher is better)
- `GET /agents/:id/goals?status=` — structured goal lifecycle
- `POST /agents/:id/goals {title, description?, priority?, status?, progress?}` (AGENT_MODIFY)
- `PATCH /agents/:id/goals/:goalId` (AGENT_MODIFY)
- `POST /agents/:id/actions {type, ...}` — validated MOVE / START_ACTIVITY / STOP_ACTIVITY / REST / IDLE (AGENT_MODIFY)

## Tasks

- `POST /tasks {title, description?, priority?, assigneeAgentId?, companyId?, projectId?, dependsOn?}`
- `GET /tasks?status=&assigneeAgentId=&companyId=&search=&page=&pageSize=` — paginated
- `GET /tasks/next-available?agentId=`
- `GET /tasks/:id` — detail + dependencies + allowed transitions
- `PATCH /tasks/:id` — status follows the state machine; illegal moves are 409
- `POST /tasks/:id/dependencies`, `DELETE /tasks/:id/dependencies/:depId`

## Conversations

- `POST /conversations {kind, title, companyId?, participantAgentIds?}`
- `GET /conversations?kind=&companyId=&agentId=`
- `GET /conversations/:id` — participants + messages
- `POST /conversations/:id/messages {content, kind?, taskId?, wakeAgent?}` — human message; wakes the sole agent participant with a run
- `POST /conversations/:id/read {agentId}`, `POST /conversations/:id/close`

## Memories

- `POST /memories {agentId, kind, content, importance?, source?}`
- `GET /memories?agentId=&kind=&query=&stats=` — list, ranked search, or stats
- `DELETE /memories/:id`

## Economy

- `GET /economy/wallets`, `GET /economy/wallets/:id`, `POST /economy/wallets/ensure`
- `POST /economy/wallets/:id/freeze {frozen}`
- `GET /economy/statement?walletId=&ownerType=&ownerId=&type=&limit=`
- `GET /economy/totals?currency=`, `GET /economy/verify`
- `POST /economy/transfer|deposit|withdraw {amount, currency?, description?, idempotencyKey?}`
- `GET /economy/treasury/:companyId`, `POST /economy/treasury/:companyId/fund|salary`

## Approvals

- `GET /approvals?status=&companyId=&risk=` — includes pending count
- `GET /approvals/:id`
- `POST /approvals/:id/decision {decision: APPROVED|REJECTED, note?, replay?}` — approving replays the frozen tool exactly once

## Tools & logs

- `GET /tools/catalogue`, `GET /tools/invocations?agentId=&toolName=&status=`, `GET /tools/providers`
- `GET /logs/events?type=&companyId=&correlationId=`, `GET /logs/activity`
- `GET /health`, `GET /ready`
