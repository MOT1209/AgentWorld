# AgentWorld — Software Factory

The factory turns a GitHub URL into a reviewed pull request through a
bounded, auditable pipeline. This document is the operator contract: the
lifecycle, the bounds, and what each stage guarantees.

## Lifecycle

```
GitHub URL -> INTAKE -> ANALYZING -> PLANNING -> BUILDING -> TESTING
  -> (FIXING -> TESTING)* -> REVIEWING -> AWAITING_APPROVAL
  -> (human merge) COMPLETED
```

Every `advance()` call moves the run at most one stage. The managed-project
view (`GET /factory/runs/:id/project`) maps these stages onto the operator
lifecycle: DISCOVERING, ANALYZING, PLANNING, TEAM_FORMING (once a team is
suggested), READY (branch exists) / DEVELOPING, TESTING, FIXING (BLOCKED when
the fix budget is exhausted), REVIEWING (READY_FOR_PR when the review gate
passes), PR_OPEN / WAITING_APPROVAL, MERGED, DEPLOYED (a deployment with
status DEPLOYED exists), FAILED, CANCELLED.

## Bounds (no infinite loops)

- `maxFixAttempts` (default 3, cap 10): FIXING re-entries. Exhaustion marks
  the run FAILED and refuses further fix tasks.
- `maxRuntimeMs` (default 1h): `advance()` throws past the budget.
- `maxModelCalls` (default 200): recorded in stats; the fix loop checks it
  before creating work.

## Stage guarantees

- ANALYZING: the repository analyzer reports observed facts (tree entries,
  manifests, CI, docs) separately from inferred findings and hypotheses.
  LLM output elsewhere is advisory and never overwrites observed facts.
- PLANNING: derived tasks, risks and the working branch are recorded.
- BUILDING: creates (or reuses) the working branch. Code changes come from
  executor agents in workspaces through the Phase 3 execution runtime.
- TESTING: reads only TestRuns in the run's own task/workspace scope (an
  unbound run refuses to advance instead of borrowing another run's result),
  consumes each settled verdict exactly once, and waits while one is in
  flight rather than queueing a duplicate job. PASSED moves to REVIEWING,
  anything else to FIXING; once the verdict is spent, the next pass queues a
  real retest.
- FIXING: increments the attempt counter and returns to TESTING. Developer
  fix work happens in the workspace against a fix task created by
  `POST /runs/:id/fix-task` (exactly one per call, refused past budget).
- REVIEWING: opens the PR when a token is configured (or records that no PR
  could be opened) and stops at AWAITING_APPROVAL.
- Approval gate: merge happens only in `approveFactoryRun`, only for a
  human principal, only from AWAITING_APPROVAL.

## Review gate

`POST /runs/:id/review` checks: scored analyzer report, derived plan tasks,
latest TestRun PASSED (missing evidence fails), no committed `.env`, fix
budget remaining, working branch set. The verdict is recorded on the run and
emitted as FACTORY_REVIEW_RECORDED. Security checks are never weakened to
pass the pipeline. Agent tool: `factory.review`. The gate never opens a PR.

## Team formation

`POST /runs/:id/team` ranks active agents by skill overlap, availability
(IDLE first), workload and reputation, with reasons per candidate. It
suggests only: assignment stays with the delegation engine. The suggestion
is recorded so the project view shows TEAM_FORMING. Agent tool:
`factory.team.suggest`.

## Testing & QA

Suites: UNIT, INTEGRATION, E2E, BROWSER, MOBILE, SECURITY, PERFORMANCE.
Every TestRun keeps status, duration, suite, logs, artifacts, failures,
environment, commit and workspace references, with labelled evidence
(observed / inferred / hypothesis).

- `browser`: queues a command (e.g. Playwright) or probes a URL. With
  neither, it records status ERROR with `simulated: true` — never a pass.
- `mobile`: queues an instrumented command. Without one, honest simulated
  ERROR. No device result is ever faked.
- `security`: real in-process self-checks (vault seal/open, credential
  shape, webhook HMAC, MCP denial, repo-URL and connector-slug validation).
  PASSED only when every check genuinely passes.
- `performance`: real bounded query-latency measurements against a 5s
  advisory budget, stored historically on the TestRun.
- `testerarmy`: reserved adapter for https://github.com/tester-army/e2e.
  Reports honest ERROR until the engine is installed; it is one adapter
  among many, never the only mechanism.

## Deployment

Targets: vercel, docker, cloud, local, custom. Every attempt records a
deployment (status, logs, artifacts, environment, rollback state) and emits
FACTORY_DEPLOY_RECORDED.

- `custom` with an explicit workspace command genuinely executes through
  the execution queue and settles to DEPLOYED only on exit zero.
- All other targets without their credential/config record BLOCKED naming
  the missing piece (e.g. VERCEL_TOKEN). Success is never claimed without
  evidence.
- Rollback runs only with a rollback command recorded at deploy time.
- Deploy requires the approval gate (AWAITING_APPROVAL or COMPLETED).

Deployments are stored on the run record plus events. A dedicated
Deployment table is the recommended next step when deployment history
needs SQL-level querying (see ROADMAP).

## Observability

Correlation IDs thread the whole pipeline: factory events, TestRuns,
execution jobs, AI usage rows and deployments all carry them. The project
view answers: what is happening (lifecycle + stage), which agent (team +
task assignee), what changed (PR + deployments), what failed and why
(failure analysis with verbatim evidence), which tests passed (test list),
and what remains (bounds + review verdict).
