# AgentWorld — Security Review (2026-10-11)

Companion to [AGENTWORLD_AUDIT.md](AGENTWORLD_AUDIT.md). "Verified" means
read in code **and** exercised by a passing test; "Reviewed" means read in
code only. Policy-level documentation stays in `docs/SECURITY.md`.

## Threats reviewed

| Threat | Controls | State |
|---|---|---|
| Token forgery / confusion | HS256 allow-list, issuer + audience, separate stream audience | Verified (existing tests) |
| Weak production config | Startup refuses placeholder/short JWT secret, default seed password | Reviewed |
| Credential brute force / enumeration | Login rate limit; dummy bcrypt for unknown accounts (AW-07) | Verified |
| Cross-company read/write (IDOR) | `scopeRefs` covers prefixed and plural id keys (AW-01, AW-02) and resolves conversation/session/job/approval/project/department ids through their rows (AW-03, AW-14) | Verified |
| Agent privilege escalation | Role ∩ capabilities; human-only permissions; skills cannot add permissions | Verified (existing + review) |
| Approval bypass / replay | Decision CAS (AW-04); tool replay single-flight; skill approvals payload-bound and single-use (AW-10); human requesters no longer crash approval creation (AW-11) | Verified |
| Double spend / ledger rewrite | Version lock, append-only triggers, idempotency bound to exact movement (AW-05) | Verified |
| Runaway AI spend | Opt-in treasury floor `AI_MIN_TREASURY_MINOR` (AW-18) | Verified (on/off test) |
| Self-approval | Opt-in `APPROVAL_FOUR_EYES` (AW-17) | Verified (on/off test) |
| Default credentials in a reused DB | Production start refuses active seed accounts accepting the dev password (AW-19) | Verified (unit) |
| Command execution escape | argv only, no shell, env filtering, option-value path checks and loader flags (AW-06); Docker sandbox: no network, read-only root, dropped caps, non-root, pid/output/time limits | Verified: 11/12 container tests pass on the `node:22-alpine` base image (the git case skipped: the repo image could not be built, package mirror blocked by egress policy) |
| Workspace path traversal / symlinks | `resolveInRoot` realpath checks | Verified (existing `tests/workspace.test.ts`, `security-m4`) |
| SSRF | `assertPublicUrl` (production), no redirects for caller URLs | Verified (existing `outbound-url-guard.test.ts`) |
| Resource exhaustion via responses | `readTextCapped` on connector/webhook/provider bodies (AW-09) | Verified |
| MCP abuse | API key must belong to active platform OWNER; scope per tool; validated task/test inputs, task engine path (AW-08); failures audited (AW-16) | Verified |
| Prompt injection via skills | Skill analyzer + trust, instructions sandboxed; enforcement stays in the executor | Reviewed |

## Remediation status

All findings AW-01 … AW-19 are addressed in this branch. AW-01 … AW-11 and
AW-14 … AW-19 each have a test; AW-12 and AW-13 are documentation and test
fixes. AW-17 (four-eyes) and AW-18 (budget floor) are **off by default**.
Open risks (audit §4): local execution is host execution, path-guard
TOCTOU, development-mode SSRF, wallet/user ids not resolved by `scopeRefs`.

## What was not done

- No penetration test against a running deployment.
- No dependency vulnerability audit (`npm audit` was not run as a gate; it
  needs registry access and its output was not reviewed here).
- The repository's own sandbox image (`docker/sandbox`) could not be built here: the Alpine package mirror is blocked by the session's egress policy (HTTP 403). The boundary tests ran on the plain `node:22-alpine` base instead; isolation flags come from the runner, not the image.
- No secrets were found or written in commits; `.env` was not created in the
  repository.
