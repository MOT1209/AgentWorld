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
| Cross-company read/write (IDOR) | `scopeRefs` now covers prefixed and plural id keys (AW-01, AW-02); explicit checks for job ids and sessions (AW-03) | Verified |
| Agent privilege escalation | Role ∩ capabilities; human-only permissions; skills cannot add permissions | Verified (existing + review) |
| Approval bypass / replay | Decision CAS (AW-04); tool replay single-flight; skill approvals payload-bound and single-use (AW-10); human requesters no longer crash approval creation (AW-11) | Verified |
| Double spend / ledger rewrite | Version lock, append-only triggers, idempotency bound to exact movement (AW-05) | Verified |
| Command execution escape | argv only, no shell, env filtering, option-value path checks and loader flags (AW-06) | Verified for policy; Docker boundary **not run** (429) |
| Workspace path traversal / symlinks | `resolveInRoot` realpath checks | Verified (existing `tests/workspace.test.ts`, `security-m4`) |
| SSRF | `assertPublicUrl` (production), no redirects for caller URLs | Verified (existing `outbound-url-guard.test.ts`) |
| Resource exhaustion via responses | `readTextCapped` on connector/webhook/provider bodies (AW-09) | Verified |
| MCP abuse | API key must belong to active platform OWNER; scope per tool; validated task/test inputs, task engine path (AW-08) | Verified |
| Prompt injection via skills | Skill analyzer + trust, instructions sandboxed; enforcement stays in the executor | Reviewed |

## Remediation status

All findings AW-01 … AW-13 are fixed in this branch; AW-01 … AW-11 each have a regression test (AW-12 and AW-13 are documentation and test fixes).
Open risks (not fixed, see audit §4): no four-eyes approval rule, no
pre-flight AI budget cap, local execution is host execution, global
execution idempotency keys, path-guard TOCTOU, development-mode SSRF,
reused seeded passwords, MCP failures unaudited.

## What was not done

- No penetration test against a running deployment.
- No dependency vulnerability audit (`npm audit` was not run as a gate; it
  needs registry access and its output was not reviewed here).
- Container escape testing blocked by Docker Hub rate limiting.
- No secrets were found or written in commits; `.env` was not created in the
  repository.
