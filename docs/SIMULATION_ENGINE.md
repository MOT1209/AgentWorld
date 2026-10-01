# King World — Simulation Engine (Phase 1)

The simulation layer lives in `packages/simulation`. It depends on the world,
agents, memory and events services and never on the HTTP layer, so the same
engine runs in tests and in the API heartbeat.

## The World row is the only source of truth

`World.status` is `INITIALIZING | RUNNING | PAUSED | STOPPED | ERROR`. There is
no in-memory "running" flag that could disagree with the database, which is why
a crash or restart cannot leave a world silently running with nobody ticking it.

`controlWorld(db, action, ctx, worldId?)` enforces a transition table:

| action | allowed from                                  | target  |
| ------ | --------------------------------------------- | ------- |
| start  | INITIALIZING, STOPPED, PAUSED, ERROR          | RUNNING |
| pause  | RUNNING                                        | PAUSED  |
| resume | PAUSED                                         | RUNNING |
| stop   | INITIALIZING, RUNNING, PAUSED, ERROR          | STOPPED |

Every control change resets `lastTickAt` to now. Without that, resuming a world
paused for an hour would apply an hour of accumulated simulated lead on the
first tick and agents would "teleport" through a day.

## Two clocks, never confused

- **Wall clock** — security (token expiry, rate limits), audit ordering.
- **Simulated clock** — `simulatedNow = wallNow + timeOffsetMinutes`.

`nextOffset` accumulates the simulation *lead* as `elapsed × (timeScale − 1)`,
so the effective rate is exactly `timeScale`, and the offset is persisted
(fractional, not floored) which makes a tick idempotent. `clampTimeScale` keeps
speed within `0.1x .. 10000x`; `SPEED_PRESETS` are `0.5, 1, 2, 10, 60`.

## The tick loop

`SimulationEngine.tick({ at?, worldId? })`:

1. Resolve the world; if its status is not `RUNNING`, return `skipped`.
2. `tickWorld(db, worldId, at)` advances and persists simulated time.
3. For each active agent in the world (capped by `maxAgentsPerTick`):
   - activate a `PLANNED` activity whose start time arrived;
   - complete an `ACTIVE` activity whose `expectedEndTime` passed;
   - apply needs decay/recovery for the simulated minutes elapsed;
   - if the agent has nothing open, ask the decision engine and execute the
     resulting action through the **same** validator an operator uses.
4. Memory housekeeping (prune expired) every `housekeepingEveryTicks` ticks.

Failure isolation is a requirement: one agent throwing is recorded in
`errors[]` and the rest still tick; a rejected decision is counted in
`decisionRejected` and logged, never fatal. The loop uses no AI provider and no
3D view, so both can be offline without stopping the world.

The heartbeat (`ensureHeartbeat`) is started at API bootstrap and its timer is
`unref`'d so it never keeps the process alive. `SIMULATION_TICK_MS` overrides
the default 5000 ms interval.

## Deterministic decisions

Phase 1 deliberately does not ask a model what an agent should do. The
`DeterministicDecisionEngine` (`deterministic-rules-v1`) is a pure function of
state, needs, day phase and location. Rule order:

1. an open activity wins (CONTINUE);
2. a sleeping agent with `ENERGY ≥ 90` wakes (IDLE);
3. `ENERGY ≤ 20` → REST;
4. `HUNGER ≤ 20` → REST (eating is a Phase 2 activity);
5. sleep phase + low energy → SLEEP;
6. `SOCIAL ≤ 25` → MOVE to the common area, else SOCIALIZE;
7. WORK/MORNING → MOVE to the work location, else WORK;
8. `ENTERTAINMENT ≤ 25` → IDLE;
9. otherwise IDLE.

`DecisionEngine` is the extension point: a future `LlmDecisionEngine` implements
the same interface, and because its output is *always* validated, a model can
propose but never bypass the lifecycle.

## Needs, skills, goals, activities

- **Needs** (`AgentState.vitals`) — `ENERGY, HUNGER, SOCIAL, REST,
  ENTERTAINMENT`, each `0..100`, higher is better. `HUNGER` means satiety.
  Deltas are per **simulated minute**, so they are independent of tick interval
  and world speed. These are gameplay numbers, not a model of biology.
- **Skills** (`Agent.skills`) — `{name, level, experience, experienceToNextLevel}`
  with `experienceToNextLevel(level) = 100 + (level − 1) × 50`. `parseSkills`
  also accepts the legacy `string[]` shape, so no data migration was needed.
  Completing an activity awards XP and can level a skill up.
- **Goals** (`AgentGoal`) — the queryable `PENDING → ACTIVE → COMPLETED`
  lifecycle with progress. The legacy free-form `Agent.goals` text is kept for
  prompt building. Completing a WORK activity advances the active goal.
- **Activities** (`AgentActivity`) — what the agent is occupationally doing over
  an interval of simulated time. Configured invariant: **at most one open
  (`PLANNED`/`ACTIVE`) activity per agent**, so "the current activity" is
  well-defined for the UI and the decision engine.

## The action gate

`validateAction(db, agentId, raw, ctx)` is the single gate, checking in order:

1. schema — the discriminated union `MOVE | START_ACTIVITY | STOP_ACTIVITY |
   REST | IDLE` parses;
2. agent — exists, is active, not `OFFLINE`/`ERROR`;
3. world — exists and is `RUNNING`;
4. permission — `assertMayActOn`: a SYSTEM actor may act on any agent, an AGENT
   only on itself, a USER needs `agent.modify`;
5. target — the destination location exists and belongs to the agent's world;
6. transition — `canTransitionAgentState` permits the resulting state;
7. conflicts — no conflicting open activity.

Only then does `executeAction` mutate, and each mutation goes through the domain
services (`moveAgent`, `startActivity`, `changeAgentState`, ...) so events and
state history are emitted exactly as for any other caller.

## Events

The engine emits, through the shared bus:

- `WORLD_STATUS_CHANGED` — one event with a from/to payload
- `AGENT_ACTIVITY_STARTED` / `AGENT_ACTIVITY_COMPLETED`
- `AGENT_GOAL_CREATED` / `AGENT_GOAL_UPDATED` / `AGENT_GOAL_COMPLETED`
- plus the existing `AGENT_STATE_CHANGED`, `LOCATION_CHANGED`, `WORLD_TICK`

`GET /events/stream` fans the persisted events to the dashboard over SSE; the
three.js view is a projection of `/simulation/state` and never a source of
truth.

## Data model added in Phase 1

- `World.timeScale` (Float), `timeOffsetMinutes` (Float), `status` (String)
- `AgentActivity` (agent, type, status, start/expected/actual times, location,
  metadata) with indexes on `(agentId, status)`, `(agentId, startTime)`,
  `locationId`
- `AgentGoal` (agent, title, priority, status, progress) indexed on
  `(agentId, status)`

Migration: `database/migrations/20261001164024_phase1_simulation`.
