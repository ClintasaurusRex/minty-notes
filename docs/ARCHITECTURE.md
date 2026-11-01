# Minty Notes — architecture and Stage 0 decisions

Status: Stage 0 decisions made and kept for Stages 1–2 (November 1, 2026). The product source of truth is `MINTY_NOTES_PLAN.md`; this file records how it is built and why.

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
| Rich text | TipTap 3.32 (`@tiptap/react`, `starter-kit`, `extensions`) on ProseMirror | MIT | Structured JSON documents, schema-enforced paste sanitizing, mature. Lexical was the alternative; TipTap's schema/JSON and `generateJSON` fit backup validation better. TipTap Pro extensions are not used. |
| IndexedDB | `idb` 8 | ISC | Tiny promise wrapper. Dexie would add more API than needed. |
| ZIP | `fflate` 0.8 | MIT | Small, fast, async (worker) zip/unzip. |
| Unit tests | Vitest 5 + `fake-indexeddb` 6 | MIT / Apache-2.0 | Run the real repository/store code in Node. |
| Browser tests | `@playwright/test` 1.63.0 (pinned to the installed browser build) | Apache-2.0 | Real Chromium checks against the production build. |
| Offline | Hand-written service worker + small Vite plugin | — | `vite-plugin-pwa` supports Vite 8 but pulls in Workbox's large build toolchain; ~50 lines cover precache + user-controlled updates. |

## Module layout

```
src/domain/     types, page geometry, rich-text schema, reference rules, search, date-only values (pure)
src/storage/    IndexedDB schema + Repository interface (the persistence boundary)
src/store/      WorkspaceStore: in-memory working copy, autosave, per-page undo/redo
src/backup/     archive format + validation, folder access, BackupService (snapshots, restore)
src/platform/   browser integrations: editor lock, service worker, downloads, storage info
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
- Printing and PDF pagination are deferred to Stage 4 and will use this same geometry.

## Projects and reusable knowledge (Stage 2)

- **One owner per page.** `Page.location` is the Inbox, standalone notes, a notebook section, or a project. Project notes are ordinary pages with `{ kind: 'project' }`, so they use the same editor, autosave, undo, backup, and Trash. General notes never need a project.
- **Links, not copies.** A project shows library pages by ID. `src/domain/references.ts` derives, per project: *pinned* (explicit `pinnedPageIds`), *suggested* (library pages whose effective categories — own ∪ section ∪ notebook — share one with the project, minus `hiddenPageIds`), *hidden*, and pinned pages that are in the Trash. There is no separate association record, so an edit to the page is the edit every project sees, and nothing can drift out of sync. This matches the plan's “project stores its categories and pin/hide overrides”.
- **Visible sharing.** A linked page shows a “Reference library — shared page, linked in …” banner naming every project that links it, also when opened from the notebook. Opened from a project, it offers **Make a project copy** and Unpin/Hide. A copy is a new page (new page and object IDs, same attachment bytes) owned by the project, labelled “Project copy — independent”; the original is unpinned/hidden in that project so the project shows its copy.
- **Matching is predictable:** explicit categories only, no AI. Categories are records (`Category`) so renaming one updates every place it is used; tags (`Tag`) are free labels used for search and filtering.
- **Recoverable deletion.** Archive keeps everything and hides the project from active lists. Trash keeps the project and its notes together. Delete forever moves the project's own notes to the page Trash (restorable to the Inbox) and removes only the project record; shared library pages are never touched. Deleting a page forever removes it from every project's pin/hide lists and clears `copiedFrom.pageId` in its copies; deleting a category or tag strips it everywhere.
- **Search** (`src/domain/search.ts`) runs in memory: project details (name, customer, site, job number, description, contacts, equipment, software, file locations, categories, status), page titles, tags, effective categories, note text, and attachment file names. Text comes from `store.loadSearchTexts()` (all stored objects, overlaid with pages open in this window), reloaded after each saved revision. Matching is accent- and case-insensitive; every word must match. Filters: project (its notes and linked references), category, tag, result type, include archived. Trashed items are excluded.
- **Home** shows open projects (not archived/trashed/complete) with due-date state, pinned references across them, recently edited project notes, recently opened pages (per device, `localStorage`), and the Inbox count.
- **File locations:** `path` entries are shown and copied (a web page cannot open arbitrary local paths); `url` entries open in a new tab only for `http`/`https`.
- **Navigation:** rail Home · Inbox · Projects · Notebooks · Notes · Search · Trash · Settings. The Projects list drills into one project (Overview, Notes, References); a page opened from a project keeps that project as context.

## Undo/redo

- Per page, in memory (cleared on reload). Entries store each changed object's before/after state, so unrelated edits never undo each other.
- Pointer gestures are one step; keyboard nudges within 1.2 s coalesce.
- Inside a focused text box, Ctrl+Z is ProseMirror's own text undo. Each text-editing session is also one page-level step that restores only the text (not position).
- Notebook/section/page management (create, rename, move, trash) is not in undo history; page delete goes through Trash.

## Storage and saving

- IndexedDB database `minty-notes` (schema version 3): `projects`, `categories`, `tags`, `notebooks`, `sections`, `pages`, `objects`, `attachments` (metadata), `blobs` (bytes), `settings`. See `DATA_FORMAT.md`. Every record store goes through the same `ChangeSet`, single-transaction commit, owner-token fencing, and revision counter.
- `WorkspaceStore` applies edits in memory and marks records dirty. Saves are debounced (400 ms, max 2 s) and written in **one transaction**; flush also runs on tab hide/close.
- Status is honest: `Unsaved changes` → `Saving…` → `Saved`, or `Not saved — retry` with a banner. A failed batch stays queued (newer edits win) and retries with backoff (1 s, 3 s, 10 s, 30 s). Quota errors get a specific message. A page-close warning appears if anything is unsaved.
- Image bytes are stored **before** any object references them; deleting an image object keeps its bytes so undo works.
- Persistent storage is requested at start; Settings reports the browser's actual answer and usage/quota.
- Single editor, enforced in three places:
  1. **Web Lock** (`minty-notes:editor`): the first window edits; later windows open read-only and follow saved changes.
  2. **Handover protocol** (BroadcastChannel): "Edit here instead" sends `takeover`; the editor replies `takeover-ack`, freezes edits, and saves. Only if everything saved does it release the lock; otherwise it replies `takeover-refused` and **keeps editing with its unsaved work**. The requester steals the lock only when no acknowledgement arrives within 3 s (a frozen window); an acknowledged editor gets up to 20 s.
  3. **Storage fencing**: each new editor writes a random owner token (`editorOwner`); every commit and restore checks it in the same transaction. A window that lost the lock — or a frozen one that wakes up — can never overwrite the new editor's work.
- Losing editing (lock stolen, or a commit refused by fencing) immediately makes the window read-only, cancels queued saves and retries, and stops backups. Unsaved changes are **held in memory** as (base, intended) pairs — the base is the stored version this window last read or wrote — counted in a banner (a page's timestamp alone does not count), and covered by the close-window warning.
- "Edit here and save them" never replays held records whole. After claiming ownership, each held change is **three-way merged field by field** against the latest stored record (`src/store/reconcile.ts`): fields only this window changed are applied; fields only the other window changed are kept; fields both changed differently keep the stored value. Bookkeeping fields (`updatedAt`) and a text box's measured height never conflict. ID lists (`categoryIds`, `tagIds`, `pinnedPageIds`, `hiddenPageIds`) merge as sets, so a pin in one window and a hide in the other both survive. A final pass removes any link to a category, tag, or page deleted in either window (noted in “Recovered changes”). Edits to records deleted elsewhere (including projects) are not resurrected; a held deletion is skipped if the record changed or is still in use elsewhere (a project that gained a note); a held move into a deleted section or project keeps the stored location, and a page created for a project deleted elsewhere is kept in the Inbox. Every such item goes into a separate **"Recovered changes" page in the Inbox** (held text, images, and before/after field notes). The result is written in one fenced transaction, then the window reloads. "Discard them" drops held changes.

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
- Image bytes from deleted objects are kept (for undo) and included in backups until a cleanup feature exists.
