# AgentWorld — Implementation Plan (2026-10-11)

Ordered by priority. Phase 1 is done in this branch; later phases are
recommendations with acceptance criteria, not implemented work.

## Phase 1 — Confirmed defects (done)

AW-01 … AW-13, see [AGENTWORLD_AUDIT.md](AGENTWORLD_AUDIT.md). Acceptance:
AW-01 … AW-11 each have a test in `tests/audit-2026-10-regressions.test.ts`
that failed before the fix and passes after (AW-12/13 are doc and test fixes); full suite, typecheck, lint, build green
(see [AGENTWORLD_TEST_REPORT.md](AGENTWORLD_TEST_REPORT.md)).

## Phase 2 — P1/P2 hardening (done, second pass)

| Item | Outcome |
|---|---|
| Run the Docker sandbox suite | 11/12 pass on `node:22-alpine`; repo image build blocked by egress policy here, CI builds it |
| Route-by-route trace of other id kinds | Found AW-14 (P1); fixed with `INDIRECT_LINKS` |
| Per-caller execution idempotency | AW-15, fixed without a migration (links are part of the replay shape) |
| Audit MCP handler failures | AW-16 |
| Four-eyes option | AW-17, `APPROVAL_FOUR_EYES` (default off) |
| Pre-flight AI budget | AW-18, `AI_MIN_TREASURY_MINOR` floor (default off) |
| Seeded password in a reused DB | AW-19, startup refusal |

### Still open (needs a decision or more design)

| Item | Acceptance criteria |
|---|---|
| Turn on four-eyes / budget floor in production | Product decision; then set the env values in deployment config |
| Cost-estimating budget (not just a floor) | Refuse when estimated cost of the call exceeds remaining budget; needs a token estimator |
| Path-guard TOCTOU | Open files with `O_NOFOLLOW` per path segment, or rely on Docker mode only; test with a racing symlink swap |
| `toUserId` / wallet ids in `scopeRefs` | Decide visibility rules for users; add loaders + isolation tests |

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
