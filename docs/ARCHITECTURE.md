# Minty Notes — architecture and Stage 0 decisions

Status: Stage 0 decisions made and kept for Stages 1–3 and the first three Stage 4 slices (November 3, 2026). The product source of truth is `MINTY_NOTES_PLAN.md`; this file records how it is built and why.

## Decision summary

**Keep** the proposed approach: React + TypeScript static app, DOM rich text (TipTap/ProseMirror) inside absolutely positioned containers, IndexedDB for records and image bytes, ZIP backups, and a service worker for offline use. Stage 0 evidence:

- Text selection vs. dragging, keyboard control, undo, paste placement, and resizing all pass real-Chromium tests (`e2e/editor.spec.ts`).
- Records + image bytes survive reload and a full backup → clean-workspace restore with identical text, image SHA-256, geometry, and notebook links (`e2e/workflow.spec.ts`, `src/backup/backup.test.ts`).
- A demanding page (85 text boxes + 15 screenshots of 1200×800) opens in ~0.53 s, keystrokes ~8 ms, pointer moves ~1 frame (`scripts/heavy-page-check.mjs`; 4 vCPU Xeon 2.1 GHz cloud container, headless Chromium 1243). Good enough to keep one live editor per text box.
- Offline reload after one online visit works from the production build (`e2e/offline.spec.ts`).

## Libraries

All free and permissively licensed; no paid features used.

| Purpose | Choice | License | Why / alternatives |
|---|---|---|---|
| UI | React 19 + React Compiler (existing) | MIT | Kept the existing Vite setup. |
| Rich text | TipTap 3.32 (`@tiptap/react`, `starter-kit`, `extensions`, `extension-table`) on ProseMirror | MIT | Structured JSON documents, schema-enforced paste sanitizing, mature. Lexical was the alternative; TipTap's schema/JSON and `generateJSON` fit backup validation better. TipTap Pro extensions are not used. Tables (Stage 4) use the free `@tiptap/extension-table` (prosemirror-tables). |
| DOCX import | `mammoth` 1.13 | BSD-2-Clause | Mature Word → HTML converter that keeps structure (headings, lists, tables, links, images). Its output is never trusted: it is rebuilt through the note schema. Runs in a Web Worker; loaded only when importing. A hand-written OOXML reader was the alternative; mammoth handles far more real-world documents. |
| PDF import and preview | `pdfjs-dist` 6.4 (PDF.js) | Apache-2.0 | Mozilla's PDF engine: text runs with positions for the draft, page rendering for the preview, parsing in its own worker. Loaded only when needed; scripts, XFA forms, and WebAssembly fetches are off. Pinned to a release a month old rather than the newest. |
| IndexedDB | `idb` 8 | ISC | Tiny promise wrapper. Dexie would add more API than needed. |
| ZIP | `fflate` 0.8 | MIT | Small, fast, async (worker) zip/unzip. |
| Unit tests | Vitest 5 + `fake-indexeddb` 6 | MIT / Apache-2.0 | Run the real repository/store code in Node. |
| Browser tests | `@playwright/test` 1.63.0 (pinned to the installed browser build) | Apache-2.0 | Real Chromium checks against the production build. |
| Offline | Hand-written service worker + small Vite plugin | — | `vite-plugin-pwa` supports Vite 8 but pulls in Workbox's large build toolchain; ~50 lines cover precache + user-controlled updates. |

## Module layout

```
src/domain/     types, page geometry, rich-text schema (tables, page links), markup rules, reference rules, search, date-only values, task and template rules (pure)
src/storage/    IndexedDB schema + Repository interface (the persistence boundary)
src/store/      WorkspaceStore: in-memory working copy, autosave, per-page undo/redo
src/backup/     archive format + validation, folder access, BackupService (snapshots, restore)
src/platform/   browser integrations: editor lock, service worker, downloads, storage info, image preparation
src/import/     document import: format detection and limits (pure), DOCX (mammoth worker) and PDF (PDF.js) conversion, PDF text rebuilding (pure)
src/app/        wiring (createServices) and React context hooks
src/ui/         React components; canvas/ holds the page editor
build/          service-worker template and the Vite plugin that writes dist/sw.js
e2e/            Playwright browser checks
```

The UI never touches IndexedDB directly. A future desktop shell can replace `Repository` and the folder functions.

## Page and editor model

- A page is 1,200 CSS px wide and grows downward: height = max(1,600, lowest object bottom + 600). Objects are clamped to `0 ≤ x`, `x + w ≤ width`, `y ≥ 0`. Pages are never cropped; content wider than the page is shrunk to fit on placement.
- View: "Fit" scales the page to the window width (never enlarges, minimum 25 %); "100 %" shows actual size. A wide note keeps its geometry on small screens.
- Text containers: width is user-set; height follows the content (measured with `ResizeObserver` and stored for placement and page height).
- Interaction rule (proved in tests): **clicking or dragging inside text always edits/selects text**. Text boxes move by the grip above them or their border; images move by dragging anywhere. Handles appear only on the selected object. Hidden grips do not intercept clicks.
- Keyboard: Esc leaves text and selects the box; arrows move (Shift ×10), Alt+arrows resize, Enter edits, Delete removes, Ctrl+D duplicates, Tab moves between objects (DOM order = reading order). Numeric X/Y/W/H fields are a second keyboard route.
- Paste: image-only clipboard → image objects placed below the selected/edited object, or near the top of the visible area, moved down past existing content (`findFreeSpot`). Text paste inside a text box is normal editor paste (schema-sanitized). Text pasted onto the page creates a new text box. Pasting an image never replaces selected text. Drag-and-drop and an "Image" file picker use the same rules.
- Screenshots display at CSS-pixel size (natural size ÷ `devicePixelRatio`), scaled to fit the page.
- New empty text boxes are discarded when you leave them (not when switching to another app, so a screenshot tool does not remove them).
- Printing and PDF pagination are the next checkpoint (note-to-PDF) and will use this same geometry.
- Contextual tools (table rows/columns, page-link actions, image markup) float over the top of the page instead of joining the toolbar, and the arrange controls are always laid out (hidden while nothing is selected). A toolbar that changes height while the pointer is down shifts the page, which turns a click into a drag selection — found and fixed in Stage 4.

## Projects and reusable knowledge (Stage 2)

- **One owner per page.** `Page.location` is the Inbox, standalone notes, a notebook section, or a project. Project notes are ordinary pages with `{ kind: 'project' }`, so they use the same editor, autosave, undo, backup, and Trash. General notes never need a project.
- **Links, not copies.** A project shows library pages by ID. `src/domain/references.ts` derives, per project: *pinned* (explicit `pinnedPageIds`), *suggested* (library pages whose effective categories — own ∪ section ∪ notebook — share one with the project, minus `hiddenPageIds`), *hidden*, and pinned pages that are in the Trash. There is no separate association record, so an edit to the page is the edit every project sees, and nothing can drift out of sync. This matches the plan's “project stores its categories and pin/hide overrides”.
- **Visible sharing.** A linked page shows a “Reference library — shared page, linked in …” banner naming every project that links it, also when opened from the notebook. Opened from a project, it offers **Make a project copy** and Unpin/Hide. A copy is a new page (new page and object IDs, same attachment bytes) owned by the project, labelled “Project copy — independent”; the original is unpinned/hidden in that project so the project shows its copy.
- **Matching is predictable:** explicit categories only, no AI. Categories are records (`Category`) so renaming one updates every place it is used; tags (`Tag`) are free labels used for search and filtering.
- **Recoverable deletion.** Archive keeps everything and hides the project from active lists. Trash keeps the project and its notes together. Delete forever moves the project's own notes to the page Trash (restorable to the Inbox) and removes only the project record; shared library pages are never touched. Deleting a page forever removes it from every project's pin/hide lists and clears `copiedFrom.pageId` in its copies; deleting a category or tag strips it everywhere.
- **Search** (`src/domain/search.ts`) runs in memory: project details (name, customer, site, job number, description, contacts, equipment, software, file locations, categories, status), page titles, tags, effective categories, note text, and attachment file names. Text comes from `store.loadSearchTexts()` (all stored objects, overlaid with pages open in this window), reloaded after each saved revision. Matching is accent- and case-insensitive; every word must match. Filters: project (its notes and linked references), category, tag, result type, include archived. Trashed items are excluded.
- **Home** shows open projects (not archived/trashed/complete) with due-date state, pinned references across them, recently edited project notes, recently opened pages (per device, `localStorage`), and the Inbox count.
- **File locations:** `path` entries are shown and copied (a web page cannot open arbitrary local paths); `url` entries open in a new tab only for `http`/`https`.
- **Navigation:** rail Home · Inbox · Projects · Notebooks · Notes · Tasks · Search · Trash · Settings. The Projects list drills into one project (Overview, Tasks, Files tabs, plus its notes and references in the side list); a page opened from a project keeps that project as context.

## Tasks, files, and templates (Stage 3)

- **Tasks are records of their own** (`Task`, store `tasks`), each owned by one project. Rules live in `src/domain/tasks.ts` (pure): column order, `placeTask` (insert before a card or at the end, renumbering only that column), `moveTarget` for keyboard moves, due-date filters, sorting, `nextTask`, and link states. The store (`createTask`, `updateTask`, `moveTask`, `nudgeTask`, `setTaskDone`, `deleteTask`, `linkTaskPage`) validates every value before it reaches storage: unknown statuses/priorities, non-`YYYY-MM-DD` due dates, and links to missing pages are ignored. Task changes use the same change sets, one-transaction autosave, owner-token fencing, and revision counter as everything else.
- **Board UI** (`src/ui/TaskBoard.tsx`): three columns; each card has a check box (complete/reopen), the title (opens the editor dialog), priority and due badges, and move buttons. Keyboard: on a focused card, **Alt+←/→** moves between columns and **Alt+↑/↓** reorders; after a move, focus follows the card to its new place and a polite live region announces “Moved … to Doing, position 1 of 2”. Drag-and-drop (HTML5) is offered for mouse users and uses the same `moveTask`. Priority is shown as a text label with a symbol (↓ • ↑ ‼) and a colored card edge — never color alone.
- **Task editor** is a native `<dialog>` (focus trap, Esc closes, focus returns). Edits autosave as you type.
- **Combined list** (`TasksView`): open tasks by default; filters for status, minimum priority, due range (overdue / today / next 7 days / later / none), project, and “Include archived projects”; sort by due date, priority, project, or recent change. Filters are a per-device convenience in `localStorage`. Tasks of trashed projects are never listed. Home shows overdue and next-7-day tasks of open projects and each project's next task.
- **Task → note links** are page IDs (`linkedPageIds`), like project pins: the note is never copied, a move keeps the link, a trashed note shows as “in the Trash” (and comes back on restore), and deleting a note forever removes the link from every task and template in the same change set. A page shows “Linked from tasks” chips that open the task. “New linked note” creates a project note titled after the task and links it.
- **Files tab** edits `Project.fileLocations` (now with a description). `path` entries are shown in monospace and copied; the UI says plainly that browsers cannot open local folders. `url` entries open only when `safeUrl` accepts them (http/https), with `target=_blank rel=noopener noreferrer`; any other scheme (e.g. `javascript:`) is kept for copying with a warning. A path that looks like a web link offers “Save it as a web link”. No Dropbox API, sync, or backend.
- **Templates** (`src/domain/templates.ts`, pure) are stored snapshots without IDs. Note templates hold one note; project templates hold reusable settings (status, description, categories, pinned library pages, equipment, software, file locations), the project's live notes, and its tasks (title, details, priority, links). Using a template always creates new records with fresh IDs; links to the template's own notes are remapped to the new notes by index, library links stay shared links, and job-specific details (name, customer, site, job number, contacts, dates, task status) are not copied. Image bytes are shared by attachment ID, which is safe because attachment bytes never change. “Save as template” is on the page header and the project header; “New from template” is on Home (notes → Inbox, projects → new project) and in a project's notes card; Settings lists, renames, describes, and deletes templates.
- **Search** also covers task titles and details (result type Task, opening the task on its board).

## Richer notes, markup, and import (Stage 4, slices 1–3)

- **Tables and code** are part of the one rich-text schema (`src/domain/richtext.ts`), so the editor, paste, import, templates, search, and restore validation all use the same rules. Table cells are extended to parse bounded spans (≤ 50) and no column widths, so outside HTML can never store a value that later fails validation or makes prosemirror-tables' table map huge. Columns size to the text box (no drag-resizing: it would not follow the pointer on a zoomed page). Tab/Shift+Tab move between cells; Esc leaves the text box, so Tab is never a keyboard trap.
- **Page links** (`src/domain/pageLink.ts`) are a mark with a page ID. An editor-only extension (`src/ui/canvas/pageLinkUi.ts`) decorates each link with its live state (title tooltip, “in Trash”, “deleted”), opens the picker on `[[` or Ctrl+Shift+K, and follows the link on Alt+Enter; the text box follows Ctrl/Cmd+click on mousedown (and a plain click in a read-only window). Events go from the editor to the page through DOM events, and the shortcut reads the live browser selection (a keyboard selection reaches ProseMirror asynchronously). The picker closes its dialog before the selection is restored, because closing returns focus to the text. `nav.followPageLink` restores a trashed target on request, explains a deleted one, keeps the current project when the target is linked there, and keeps a Back stack. Backlinks (“Linked from notes”) are read once when a page opens (`store.pagesLinkingTo`, a scan of all stored objects). Deleting a page forever does not rewrite other notes: their links stay and show “deleted”.
- **Markup** (`src/domain/markup.ts`, pure) stores annotations in the image's natural pixel space, so they scale with the object; `crop` is a view rectangle. `MarkupSvg` draws the same markup on the page and in the editor (SVG: image, blurred copies clipped to blur areas, redaction boxes, then the rest); `markupExport.ts` draws it again on a canvas for the flattened PNG. The editor (`MarkupEditor.tsx`) is a full-window modal: it keeps its own undo stack and saves once (one page undo step). While any modal dialog is open, the page ignores its shortcuts, paste, and Alt+N (Ctrl+Z in the editor once reached page undo and removed the screenshot itself — found and fixed). Sketches are a separate object type with the same markup and no image.
- **Blur and redaction are defined, not implied:** blur is visual only; a redaction box is an opaque cover on screen. The workspace (and every backup) keeps the original pixels. Only “Save PNG copy” produces a file in which redacted pixels are replaced (checked pixel-by-pixel in a browser test). Note-to-PDF export must use the same flattening.
- **Import** (`src/import/`): bytes decide the format (never the file name); limits are checked first (50 MB file; DOCX ≤ 300 MB unpacked and ≤ 5,000 parts, read from the ZIP directory without unpacking; ≤ 300 PDF pages; ≤ 200 pictures; ≤ 2 M characters). DOCX: mammoth runs in a module Web Worker (2-minute limit; falls back to the page thread if workers are unavailable), with external file access off; its HTML is parsed in an inert `DOMParser` document (no scripts, no fetches), split into sections at headings and every 40 blocks, and rebuilt through the note schema (unknown elements, event attributes, and unsafe links are dropped). PDF: PDF.js text runs are grouped into lines, paragraphs, headings (by size), and bullet lists (`pdfText.ts`, pure); scanned pages, pictures, annotations/forms, scripts, attachments, and page limits become conversion notes. Sections are measured with the editor's own CSS before placement, so they stack without overlapping. The original is stored first (unchanged), then the page; a real document that cannot be converted is kept only after asking. The preview draws PDF pages with PDF.js and rebuilds a DOCX read-only from the stored file. Converters are separate chunks in the offline precache.

## Undo/redo

- Per page, in memory (cleared on reload). Entries store each changed object's before/after state, so unrelated edits never undo each other.
- Pointer gestures are one step; keyboard nudges within 1.2 s coalesce.
- Inside a focused text box, Ctrl+Z is ProseMirror's own text undo. Each text-editing session is also one page-level step that restores only the text (not position).
- Notebook/section/page management (create, rename, move, trash) is not in undo history; page delete goes through Trash.

## Storage and saving

- IndexedDB database `minty-notes` (schema version 5): `projects`, `tasks`, `templates`, `categories`, `tags`, `notebooks`, `sections`, `pages`, `objects`, `attachments` (metadata), `blobs` (bytes of images and imported originals), `settings`. See `DATA_FORMAT.md`. Every record store goes through the same `ChangeSet`, single-transaction commit, owner-token fencing, and revision counter.
- `WorkspaceStore` applies edits in memory and marks records dirty. Saves are debounced (400 ms, max 2 s) and written in **one transaction**; flush also runs on tab hide/close.
- Status is honest: `Unsaved changes` → `Saving…` → `Saved`, or `Not saved — retry` with a banner. A failed batch stays queued (newer edits win) and retries with backoff (1 s, 3 s, 10 s, 30 s). Quota errors get a specific message. A page-close warning appears if anything is unsaved.
- Image bytes are stored **before** any object references them; deleting an image object keeps its bytes so undo works.
- Persistent storage is requested at start; Settings reports the browser's actual answer and usage/quota.
- Single editor, enforced in three places:
  1. **Web Lock** (`minty-notes:editor`): the first window edits; later windows open read-only and follow saved changes.
  2. **Handover protocol** (BroadcastChannel): "Edit here instead" sends `takeover`; the editor replies `takeover-ack`, freezes edits, and saves. Only if everything saved does it release the lock; otherwise it replies `takeover-refused` and **keeps editing with its unsaved work**. The requester steals the lock only when no acknowledgement arrives within 3 s (a frozen window); an acknowledged editor gets up to 20 s.
  3. **Storage fencing**: each new editor writes a random owner token (`editorOwner`); every commit and restore checks it in the same transaction. A window that lost the lock — or a frozen one that wakes up — can never overwrite the new editor's work.
- Losing editing (lock stolen, or a commit refused by fencing) immediately makes the window read-only, cancels queued saves and retries, and stops backups. Unsaved changes are **held in memory** as (base, intended) pairs — the base is the stored version this window last read or wrote — counted in a banner (a page's timestamp alone does not count), and covered by the close-window warning.
- "Edit here and save them" never replays held records whole. After claiming ownership, each held change is **three-way merged field by field** against the latest stored record (`src/store/reconcile.ts`): fields only this window changed are applied; fields only the other window changed are kept; fields both changed differently keep the stored value. Bookkeeping fields (`updatedAt`) and a text box's measured height never conflict. ID lists (`categoryIds`, `tagIds`, `pinnedPageIds`, `hiddenPageIds`, a task's `linkedPageIds`) merge as sets, so a pin in one window and a hide in the other both survive. A final pass removes any link to a category, tag, or page deleted in either window — including task links and template references (noted in “Recovered changes”). A task created for a project deleted elsewhere is not attached to nothing: its title and details go to “Recovered changes”. A held project deletion is refused when the other window still uses the project (a note or a task) or changed it; then the project's tasks are not deleted either, and a refused page deletion keeps task and template links to the page. Edits to records deleted elsewhere (including projects) are not resurrected; a held deletion is skipped if the record changed or is still in use elsewhere (a project that gained a note), and then **none of its side effects are applied either** — a kept project keeps its notes, a kept category or tag stays on every record, and a kept page keeps its content, pins, hides, and its copies' source link (`withoutRefusedCascades`); a held move into a deleted section or project keeps the stored location, and a page created for a project deleted elsewhere is kept in the Inbox. Every such item goes into a separate **"Recovered changes" page in the Inbox** (held text, images, and before/after field notes). The result is written in one fenced transaction, then the window reloads. "Discard them" drops held changes.

## Backup and restore

- Archive: ZIP with `manifest.json` (format, version, counts, SHA-256 of every file), `records.json`, `attachments/<id>.<ext>`, `README.txt`.
- Restore validates **everything before changing anything**: ZIP structure and safe paths, size limits, format name and version (newer formats are refused), checksums, record shapes, unique IDs, every relationship, rich text against the editor schema, and attachment bytes. The user sees a summary and confirms.
- Before replacing, the current workspace is saved as a safety copy (in IndexedDB, and in the backup folder when connected). If that fails, nothing is restored. The replacement is a single IndexedDB transaction, so a failure leaves the old workspace intact.
- Folder snapshots (Chrome/Edge File System Access API): manual "Back up now", plus automatic snapshots every 30 minutes **while the app is open and changes exist**, checked each minute and on return to the tab. "Changes exist" compares the stored `revision` with the revision the last snapshot captured (read in the same transaction as the archived records), so equal timestamps, clock changes, or edits saved while a backup is being prepared cannot hide a change. The 30-minute interval uses a monotonic clock within a session and wall time across restarts; a clock that moved backwards counts as due. Only the editing window writes folder snapshots. Files are written via a temporary file and only appear when complete; size is verified; the newest 10 `minty-notes-backup-*.zip` files are kept and older ones are pruned **only after** a successful write. Other files in the folder are never touched.
- Permission states (`granted`, `prompt`, `denied`, missing folder) are shown in the status pill, a banner, and Settings; "Reconnect folder" renews access with a user click. The download fallback always works.
- Crash guard: reading the saved folder handle is bracketed by a per-tab marker; if a read ever takes the page down, the next start forgets the handle and asks the user to choose the folder again (no crash loop).

## Offline and updates

- `build/serviceWorkerPlugin.ts` writes `dist/sw.js` after each build with the exact output file list and a content hash. Install caches all files or fails (never a partial cache).
- Navigation is served from the cached `index.html`; assets cache-first with `ignoreVary` (local and static hosts send `Vary` headers that otherwise break cache matches).
- "Offline ready" shows only once an installed worker is active. A new version waits; "Save and update" flushes saves first, then activates it and reloads.
- `base: './'` makes the build work from any stable HTTPS path. Changing the hosting address creates a separate browser workspace; move data with backup → restore.
- `manifest.webmanifest` + PNG/SVG icons make it installable from Chrome; the browser tab version works the same.

## Known risks carried forward

- One live TipTap editor per text box is fine at 85 boxes; revisit (lazy mounting) if Stage 5 datasets show slow page opens.
- Backups are built in memory; very large workspaces (hundreds of MB) may need streaming writes in Stage 5.
- Image bytes from deleted objects are kept (for undo) and included in backups until a cleanup feature exists; the same applies to originals of deleted imported drafts.
- `pagesLinkingTo` and search read every stored object; fine for current tests, not yet measured on the 1,000-page dataset (Stage 5).
- The main bundle is ~1.08 MB (≈ 340 KB gzip) after tables and markup; mammoth (~310 KB) and PDF.js (~430 KB + 1.26 MB worker) load only when used.
