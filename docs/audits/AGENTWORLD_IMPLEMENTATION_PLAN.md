# AgentWorld — Implementation Plan (2026-10-11)

Ordered by priority. Phase 1 is done in this branch; later phases are
recommendations with acceptance criteria, not implemented work.

## Phase 1 — Confirmed defects (done)

AW-01 … AW-12, see [AGENTWORLD_AUDIT.md](AGENTWORLD_AUDIT.md). Acceptance:
each has a test in `tests/audit-2026-10-regressions.test.ts` that failed
before the fix and passes after; full suite, typecheck, lint, build green
(see [AGENTWORLD_TEST_REPORT.md](AGENTWORLD_TEST_REPORT.md)).

## Phase 2 — P1/P2 hardening (recommended next)

| Item | Why | Acceptance criteria | Depends on |
|---|---|---|---|
| Run the Docker sandbox suite | Only real boundary for untrusted agents; blocked here | `tests/docker-sandbox.test.ts` passes on Linux CI (already wired in `ci.yml`) | Docker Hub access / registry mirror |
| Pre-flight AI budget cap | Spend is charged after the fact only | A run is refused (and evented) when the company's remaining budget is below the call's estimated cost; test with mock costs | Decide budget source (treasury balance vs. explicit cap) |
| Four-eyes option for approvals | Requester can approve own request | Config flag; when on, `decideApproval` refuses `decidedByUserId === requesterUserId`; test both modes | Product decision |
| Route-by-route trace of other id kinds | `conversationId`, `approvalRequestId`, `toUserId`, wallet ids are not covered by `scopeRefs` | Each route either scope-checks or is documented as platform-level; one isolation test per route | — |
| Audit MCP handler failures | Only success/denial are evented | `MCP_REQUEST` with `authorized: true, error` on throw; test | — |
| Per-caller execution idempotency | Global key namespace | Key unique per (createdBy, key) via migration; test cross-user collision | Migration + `tests/setup.ts` |

## Phase 3 — P3 / developer experience

- Consider the official `@modelcontextprotocol/sdk` only if a stdio transport
  or MCP client is actually needed; the current hand-rolled HTTP server works
  and is tested. Replacing it now would be churn without a demonstrated gap.
- `npm audit` in CI as a non-blocking report.
- Code-split the 557 kB `three` chunk in `apps/web` (Vite warning).

## Remaining risks

Listed in [AGENTWORLD_AUDIT.md §4](AGENTWORLD_AUDIT.md#4-risks-requiring-further-validation-not-confirmed-defects).
None of them is a confirmed exploitable defect in the default production
configuration (Docker sandbox), but the Docker boundary itself is unverified
in this environment.
