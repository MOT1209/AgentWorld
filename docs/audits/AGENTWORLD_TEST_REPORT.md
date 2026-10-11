# AgentWorld — Test Report (2026-10-11)

Environment: Linux container, Node v22.22.0, npm 10.9.4, SQLite via Prisma 6.
No `.env` file (defaults from `packages/shared/src/config.ts`). Docker daemon
started manually; image pull blocked (see below).

## Baseline (base commit `6476d9c`, before any change)

| Command | Exit | Result |
|---|---|---|
| `npm ci` | 0 | Installed (deprecation warnings only) |
| `npm run db:generate` | 0 | Prisma client generated |
| `npm run doctor` | 1 | Environment only: `.env` missing → `DATABASE_URL` unset. Not a code defect. |
| `npm run check:docs` | 0 | 82 tools, 50 models, 20 vendors, MCP 21 tools / 10 resources match README |
| `npm run typecheck` | 0 | Clean |
| `npm run lint` | 0 | Clean |
| `npm test` | 0 | 42 files: 40 passed, 2 skipped; **424 tests: 411 passed, 13 skipped**; 87 s |
| `npm run build` | 0 | API + web built; Vite warns the `three` chunk is 557 kB |

`npm run db` does not exist (the scripts are `db:*`). `npm run verify` was
run as its component steps above. `db:migrate` / `db:reset` were not run:
tests build throwaway databases from the migration SQL, and reset is
destructive.

## Reproduction

`tests/audit-2026-10-regressions.test.ts` (16 tests) was written first and run
against the unmodified code: every defect test failed (14 of 15 in the first
run; the 15th is a guard that routine commands stay allowed, which passed as
expected). AW-10 was added after AW-11 was discovered; it was confirmed to fail
(201 instead of 202) with only the skill-route fix reverted.

## Final (this branch)

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | Clean |
| `npm run lint` | 0 | Clean |
| `npm run check:docs` | 0 | Counts match |
| `npm test` | 0 | 43 files: 41 passed, 2 skipped; **440 tests: 427 passed, 13 skipped**; 97 s |
| `npm run build` | 0 | Same chunk-size warning as baseline |

Delta: +16 new regression tests; no existing test removed, skipped or
weakened.

### One failure seen and its cause

The first final run had 1 failure:
`tests/security-regressions.test.ts › OAuth state integrity › rejects a
tampered or truncated signature` ("fetch failed" instead of "signature
mismatch"). Cause: a **test bug**, unrelated to this change. The test checked
`signature.endsWith("A")` but replaced the *first* character, so when the
signature already started with the replacement letter (≈1.6 % of runs) the
"tampered" state equalled the genuine one. Fixed to `startsWith`, which makes
the test always tamper (strictly stronger). Product code
(`packages/connectors/src/oauth.ts`) was correct. Passed 3/3 reruns and in the
final full run.

## Second pass (AW-14 … AW-19)

AW-14, AW-15 and AW-16 were confirmed failing before their fixes (AW-14: the
agent run returned 200; AW-15 and AW-16 by reverting only the fixed file).

Docker: the daemon was started and `node:22-alpine` pulled successfully this
time, but the repository image (`docker/sandbox`) still could not be built:
`apk add` gets **HTTP 403 from the session's egress policy** for
`dl-cdn.alpinelinux.org`. The boundary suite was run against the plain base
image under a test-only tag (`TEST_DOCKER_IMAGE=kingworld-sandbox:base-only`);
the isolation flags come from `DockerRunner`, not the image.

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | Clean |
| `npm run lint` | 0 | Clean |
| `npm run check:docs` | 0 | Counts match |
| `npm test` (with Docker) | 0 | 43 files: 42 passed, 1 skipped; **447 tests: 445 passed, 2 skipped**; 92 s |
| `npm run build` | 0 | Same chunk-size warning |

`tests/docker-sandbox.test.ts`: 11 passed (non-root user, no network, no host
filesystem, read-only root, dropped capabilities, pid cap, timeout kill, live
kill, output cap, fail-closed, root-owned refusal); 1 skipped (git inside the
container — the base image has no git).

## Skipped and blocked (first pass)

| Suite | Tests | Why |
|---|---|---|
| `tests/docker-sandbox.test.ts` | 12 skipped | Needs image `kingworld-sandbox:1`. `docker build` failed twice: Docker Hub `429 Too Many Requests` for `node:22-alpine`. CI builds the image on Linux. |
| `tests/opencode-smoke.test.ts` | 1 skipped | `opencode` binary absent / opt-in unset (by design) |
| Windows CI leg | not run | Linux container only |
| Real AI vendors, OAuth, GitHub | not run | No credentials; mock provider and stubbed `fetch` only |

No coverage run was performed (`npm run test:coverage` not executed); no
coverage figures are claimed.
