# Minty Notes

A local-first notebook for technical projects and reusable knowledge, in the Minty charcoal-and-mint style. Notes, layouts, and screenshots stay in your browser on your computer — no account, server, or subscription.

**Status:** Stages 0–3 and the first three Stage 4 slices — a working notebook with reliable local saving, backups, and offline use; projects, a reusable reference library, tags, search, and a home dashboard; task boards, task-to-note links, a project Files tab, and templates; and (0.4.0) tables, code blocks, internal page links, screenshot markup and sketches, and local DOCX/PDF import. Note-to-PDF export and portable project export/import are the next checkpoint. See `docs/PROGRESS.md`.

## What it does now

- **Home:** active projects (with each one's next task), overdue and upcoming tasks, pinned references, recently edited project notes, recently opened pages, and “New from template”.
- **Quick capture:** “Quick note” (or **Alt+N**) opens a new note in the Inbox. No project or notebook needed.
- **Projects:** Overview, Tasks, and Files tabs. Customer, site, job number, status, due date, contacts, equipment, software versions, and several system categories. Project notes use the same page editor. Archive, Trash, and restore; deleting a project forever keeps its notes in the Trash and never touches shared library pages.
- **Tasks:** a To do / Doing / Done board per project. Title, details, priority (Low / Normal / High / Urgent, shown with a label and symbol), and an optional date-only due date with overdue and due-soon markers. Move by drag-and-drop, the arrow buttons, or **Alt+←/→** (column) and **Alt+↑/↓** (order) on a focused task. Link tasks to existing notes (or create a linked note); a note shows which tasks link to it.
- **All tasks:** the Tasks screen lists tasks across projects with status, priority, due-date, and project filters, sorting, and an “Include archived projects” switch. Click a task to open it on its project's board.
- **Files tab:** saved local paths (copied with one click; browsers cannot open local folders) and web links such as Dropbox links (http/https only, opened in a new tab), each with a description. Only the location is stored.
- **Templates:** “Save as template” on a page or a project; “New from template” on Home or in a project. Every use makes new, independent notes, tasks, and projects. Manage templates in Settings.
- **Reference library:** give a notebook, section, or page a system category (e.g. VTScada). Projects with that category suggest those pages automatically. Pin extra pages or hide suggestions per project. Linked pages are the originals — an edit shows in every project, and the page says it is shared. **Make a project copy** creates an independent page instead.
- **Tags and search:** tag pages; search project details, note titles and text, task titles and details, tags, categories, and attachment names, with project, category, tag, type, and archived filters. Everything is searched locally.
- **Organize:** standalone notes, or notebooks → sections → pages. Move pages anytime; links and IDs stay the same. Trash with restore.
- **Freeform pages:** a 1,200 px page that grows downward. Add text boxes (double-click the page or “Text”) and images anywhere; move, resize, layer, duplicate.
- **Screenshots:** take a screenshot, click the page, press **Ctrl+V**. Images can also be dropped in or picked from a file.
- **Rich text:** headings, bold/italic/underline/strike, inline code and code blocks, lists, quotes, web links, and **tables** (Tab between cells; row/column controls appear while you are in a table).
- **Page links:** type `[[` (or Ctrl+Shift+K, or the link button) to link to another page. Ctrl+click or Alt+Enter follows a link; “← Back” returns. Links follow moved or renamed pages, show when the page is in the Trash, and stay readable (marked “deleted”) if it is deleted forever. Pages show which notes link to them.
- **Screenshot markup and sketches:** select an image and choose **Mark up** (or press Enter / double-click): arrows, lines, rectangles, ellipses, labels, pen, highlighter, crop, blur, and redaction boxes, all editable later. **Sketch** adds a vector drawing for simple wiring diagrams. The original image file never changes. **Blur is visual only and a redaction box only covers the area on screen — the original pixels stay in this workspace and its backups.** “Save PNG copy” downloads a flattened image in which redacted areas are solid black.
- **Import documents:** “Import document” (Inbox, notes, notebook sections, projects) turns a .docx or text-based PDF into an editable draft and keeps the original file unchanged (preview, download, and a list of what did not convert). No OCR: scanned PDFs can only be kept as originals.
- **Undo/redo:** Ctrl+Z / Ctrl+Shift+Z.
- **Autosave:** the top bar always says Saved, Saving…, Unsaved changes, or Not saved (with retry).
- **Backups:** choose a backup folder (Chrome/Edge), or download a backup ZIP. Backups include projects, tasks, templates, links, categories, tags, image markup, sketches, and imported original files. Restore checks the whole file first and keeps a safety copy of what it replaces. Older (Stage 1–3) backups still restore. A backup is a complete working copy, not a redacted file for sharing.
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
