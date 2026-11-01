# Minty Notes — notes for coding sessions

- Product source of truth: `docs/MINTY_NOTES_PLAN.md`. Stage prompts: `docs/CLAUDE_CODE_HANDOFF.md`.
- Read `docs/PROGRESS.md` first (status, checks, limitations, exact next task), then `docs/ARCHITECTURE.md` and `docs/DATA_FORMAT.md`.
- Only work on the stage you were asked for. Do not deploy.
- Stack: Vite 8 + React 19 + React Compiler + TypeScript `~6.0` (keep below 6.1 for typescript-eslint). Never use `--force`/`--legacy-peer-deps`.
- Keep layers separate: `domain` (pure) → `storage` (IndexedDB via `Repository`) → `store` (working copy, autosave, undo) → `backup`/`platform` → `ui`.
- Any change to stored records or backups: bump/migrate `FORMAT_VERSION` or `DB_VERSION`, update `DATA_FORMAT.md`, add a test. Existing user data must survive.
- Checks: `npm run check` (build, lint, unit tests) and `npm run test:e2e` (Playwright, production build). `@playwright/test` is pinned to the installed browser build.
- Say clearly which checks were real browser behavior and which were simulated (folder picker, permission prompts, disk-full).
- Update `docs/PROGRESS.md` at the end of each milestone.
