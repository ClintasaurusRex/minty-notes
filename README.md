# Minty Notes

A local-first notebook for technical projects and reusable knowledge, in the Minty charcoal-and-mint style. Notes, layouts, and screenshots stay in your browser on your computer — no account, server, or subscription.

**Status:** first milestone (Stage 0 + Stage 1) — a working notebook with reliable local saving, backups, and offline use. Projects, tasks, search, and document import come in later stages. See `docs/PROGRESS.md`.

## What it does now

- **Quick capture:** “Quick note” (or **Alt+N**) opens a new note in the Inbox. No project or notebook needed.
- **Organize:** standalone notes, or notebooks → sections → pages. Move pages anytime; links and IDs stay the same. Trash with restore.
- **Freeform pages:** a 1,200 px page that grows downward. Add text boxes (double-click the page or “Text”) and images anywhere; move, resize, layer, duplicate.
- **Screenshots:** take a screenshot, click the page, press **Ctrl+V**. Images can also be dropped in or picked from a file.
- **Rich text:** headings, bold/italic/underline/strike, code, lists, quotes, links.
- **Undo/redo:** Ctrl+Z / Ctrl+Shift+Z.
- **Autosave:** the top bar always says Saved, Saving…, Unsaved changes, or Not saved (with retry).
- **Backups:** choose a backup folder (Chrome/Edge), or download a backup ZIP. Restore checks the whole file first and keeps a safety copy of what it replaces.
- **Offline:** after the first visit, the app opens without a connection.

Keyboard shortcuts are listed in Settings.

## Run it

Needs Node.js 22+ and npm.

```bash
npm ci
```

```bash
npm run dev
```

Then open the printed local address in Chrome. The development server does not enable offline mode.

To try the real production build (with offline support):

```bash
npm run build
```

```bash
npm run preview
```

## Checks

```bash
npm run check
```

Runs the TypeScript build, ESLint, and the unit/integration tests.

Browser tests (builds the app and serves it on port 4173):

```bash
npm run test:e2e
```

On a new machine, install Playwright's browser first:

```bash
npx playwright install chromium
```

## Backups — what to know

- Your working copy lives in this browser profile at this web address. Clearing site data deletes it — keep backups.
- With a backup folder chosen, a snapshot is saved every 30 minutes **while the app is open** and something changed. The newest 10 are kept.
- Folder access can lapse after a browser restart; the app shows “Backups paused” and a **Reconnect folder** button.
- A backup in a Dropbox folder is a recoverable copy, not live sync between computers.

## Deploying (later)

The build in `dist/` is static and uses relative paths, so it can be served from any stable HTTPS address. Not deployed yet. Moving to a new address means backup → restore, because browser storage belongs to the address.

## Documentation

- `docs/MINTY_NOTES_PLAN.md` — product plan (source of truth)
- `docs/ARCHITECTURE.md` — decisions, libraries, and how things work
- `docs/DATA_FORMAT.md` — stored records and backup format
- `docs/PROGRESS.md` — what's done, how it was checked, limitations, next task
- `docs/CLAUDE_CODE_HANDOFF.md` — build prompts for each stage
