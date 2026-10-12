# Changelog

All notable changes. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
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
- Software Factory wording now matches the code: it tracks, gates and audits a change from a GitHub URL to a
  reviewed pull request, but does not clone the repository, write code or push commits (README, FACTORY.md).
- Product-facing name is **AgentWorld**. The seeded demo world ("King World", "King City") and the
  default owner account (`king@kingworld.local`) keep their names so existing databases stay valid;
  the `@kingworld/*` package scope is unchanged.
- `.env.example` documents every variable the code reads, plus a production checklist.
- `npm run doctor` now loads `.env`, so its checks see your configuration.

### Fixed
- SSRF guard: IPv6 literals, private ranges and redirects are now checked.
