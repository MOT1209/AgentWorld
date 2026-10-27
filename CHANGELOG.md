# Changelog

All notable changes. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- License: Apache-2.0 (`LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, `license` field in `package.json`).
- Stylized cartoon 3D city: characters, buildings and street decor built by headless Blender scripts
  (`tools/blender`), exported as small GLB files, with procedural fallbacks.
- Operator console redesign: grouped sidebar, bundled fonts, design tokens, hero city view, overview
  tiles on the World tab, mobile section picker.
- Company isolation: company-linked records are scoped to the people allowed to see them.
- Deployment: `Dockerfile`, `docker-compose.yml`, `SERVE_WEB` (the API serves the built dashboard, same
  origin), WAL mode in production, `npm run db:backup`, and `docs/DEPLOYMENT.md`. CI builds the image and
  smoke-tests a login against it.
- `CHANGELOG.md`, issue and pull request templates; CI least-privilege permissions, run
  cancellation and a production dependency audit.

### Changed
- Dependencies: `zod` 3 -> 4.6.7 and `body-parser` 1.20.9 to clear two high-severity `npm audit` advisories that were
  published after main last passed (the CI audit gate was red for every PR). `zod` is now declared at the root so it hoists
  for `packages/*`; tool schemas are converted to JSON Schema with `z.toJSONSchema` (same contract: closed objects, no `$schema`).
- Software Factory wording now matches the code: it tracks, gates and audits a change from a GitHub URL to a
  reviewed pull request, but does not clone the repository, write code or push commits (README, FACTORY.md).
- Product-facing name is **AgentWorld**. The seeded demo world ("King World", "King City") and the
  default owner account (`king@kingworld.local`) keep their names so existing databases stay valid;
  the `@kingworld/*` package scope is unchanged.
- `.env.example` documents every variable the code reads, plus a production checklist.
- `npm run doctor` now loads `.env`, so its checks see your configuration.

### Fixed
- Fourth-pass audit (AW-28..AW-33): task dependencies can no longer point at another company's task (REST and
  `task.create`; a refused `dependsOn` no longer leaves the new task behind); factory and testing tools scope
  `factoryRunId`/`testRunId` and their lists to the agent's company; economy routes check wallet visibility and
  `/wallets/ensure` needs a real, visible owner; skill usage and skill-request decisions respect company scope;
  OAuth state signing refuses the public fallback key in production; the test DROP list covers every table.
  See `docs/audits/AGENTWORLD_AUDIT_2026-10-26_PASS4.md`.
- Agent tool calls now respect company isolation (AW-24..AW-27): role messages and escalation routing stay
  in the sender's company, `wallet.transfer` validates its recipient and holds cross-company payments for
  approval, the `testing.run` URL probe uses the outbound guard in production, and task/plan/conversation
  ids and lists are scoped for agents. See `docs/audits/AGENTWORLD_AUDIT_2026-10-12_PASS3.md`.
- SSRF guard: IPv6 literals, private ranges and redirects are now checked.
