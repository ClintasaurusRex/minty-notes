# Minty Notes

A local-first notebook for technical projects and reusable knowledge, in the Minty charcoal-and-mint style. Notes, layouts, and screenshots stay in your browser on your computer — no account, server, or subscription.

**Status:** Stages 0–2 — a working notebook with reliable local saving, backups, and offline use, plus projects, a reusable reference library, tags, search, and a home dashboard. Tasks, templates, and document import come in later stages. See `docs/PROGRESS.md`.

## What it does now

- **Home:** active projects, pinned references, recently edited project notes, and recently opened pages.
- **Quick capture:** “Quick note” (or **Alt+N**) opens a new note in the Inbox. No project or notebook needed.
- **Projects:** customer, site, job number, status, due date, contacts, equipment, software versions, saved file locations (paths to copy, web links to open), and several system categories. Project notes use the same page editor. Archive, Trash, and restore; deleting a project forever keeps its notes in the Trash and never touches shared library pages.
- **Reference library:** give a notebook, section, or page a system category (e.g. VTScada). Projects with that category suggest those pages automatically. Pin extra pages or hide suggestions per project. Linked pages are the originals — an edit shows in every project, and the page says it is shared. **Make a project copy** creates an independent page instead.
- **Tags and search:** tag pages; search project details, note titles and text, tags, categories, and attachment names, with project, category, tag, type, and archived filters. Everything is searched locally.
- **Organize:** standalone notes, or notebooks → sections → pages. Move pages anytime; links and IDs stay the same. Trash with restore.
- **Freeform pages:** a 1,200 px page that grows downward. Add text boxes (double-click the page or “Text”) and images anywhere; move, resize, layer, duplicate.
- **Screenshots:** take a screenshot, click the page, press **Ctrl+V**. Images can also be dropped in or picked from a file.
- **Rich text:** headings, bold/italic/underline/strike, code, lists, quotes, links.
- **Undo/redo:** Ctrl+Z / Ctrl+Shift+Z.
- **Autosave:** the top bar always says Saved, Saving…, Unsaved changes, or Not saved (with retry).
- **Backups:** choose a backup folder (Chrome/Edge), or download a backup ZIP. Backups include projects, links, categories, and tags. Restore checks the whole file first and keeps a safety copy of what it replaces. Older (Stage 1) backups still restore.
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
