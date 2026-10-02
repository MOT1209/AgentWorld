# Contributing to AgentWorld

## One command to trust

```bash
npm run verify   # typecheck -> lint -> test -> build
```

Every change must keep it green. No exceptions, no "it works on my machine".

## Environment quirks (read before debugging tooling)

- **Prisma CLI hangs here** (`prisma --version` never returns). Never call it
  directly: use `npm run db:generate` (works), and for migrations use
  `npx tsx scripts/apply-migration.ts <migration-dir>` (see below).
- **`npx` hangs here.** Call binaries directly:
  `.\node_modules\.bin\vitest.cmd run`, `.\node_modules\.bin\tsx.cmd …`.
- First run `npm run doctor` — it checks node version, env, generated client,
  and database writability, and tells you exactly what to fix.

## Database workflow (no `migrate deploy`)

1. Edit `database/schema.prisma`.
2. Write the migration SQL by hand in
   `database/migrations/<timestamp>_<name>/migration.sql`
   (SQLite dialect; triggers need `BEGIN…END` kept intact).
3. `npx tsx scripts/apply-migration.ts <timestamp>_<name>` for `dev.db`
   (or rather: `.\node_modules\.bin\tsx.cmd scripts/apply-migration.ts …`).
4. `npm run db:generate` to refresh `@prisma/client`.
5. Extend `tests/setup.ts` DROP list if you added tables (dependency order:
   children before parents).

Tests never touch `dev.db`: `tests/setup.ts` rebuilds an isolated
`test-<pid>.db` from the migration SQL on every run.

## Concurrency protocol (mandatory)

**Two sessions never edit the same tree at once.** Before starting work,
check `git status` for uncommitted changes you don't recognize and ask.
Prefer short-lived feature branches + PR review over pushing straight to
`main`. Test databases are per-process, but source files are shared.

## Code rules

- Strict TypeScript (`noUncheckedIndexedAccess`, no `any`), ESLint clean.
- Money is integer minor units. Never floats.
- Agents act only through tools. No service imports in the runtime.
- Behaviour by `roleKey`, never by agent name.
- Every state change emits an event + audit row, including denials.
- Secrets never touch rows, logs, or `VITE_*` vars.
