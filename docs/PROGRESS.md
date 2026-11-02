# Minty Notes — progress

Last updated: November 2, 2026 · Branch: `claude/bold-mccarthy-ymvezs` (from `claude/great-gauss-e9zx88` at `3af576f`) · App version 0.2.1

## Status

**Stages 0, 1, and 2 are complete and checked.** Stage 2 adds projects, the reusable reference library (category suggestions, pins, hides, live links, project copies), tags, local search, the home dashboard, and project archive/trash — on data format 2 / IndexedDB version 3 with migrations from Stage 1. Stages 3–6 have not started. Nothing has been deployed.

## Completed

### Stage 0 — risky interactions resolved
- Decision recorded in `ARCHITECTURE.md`: keep TipTap DOM rich text in positioned containers, IndexedDB records + blobs, ZIP backups, custom service worker.
- Proved: text selection vs. dragging, resize with re-wrapping, keyboard alternatives, screenshot persistence, folder snapshot logic, complete backup → clean restore, offline launch. Prototype code became the Stage 1 code.

### Stage 1 — useful notebook core
- Minty charcoal/mint shell: narrow main navigation, collapsible page list, compact toolbar, centered charcoal page, mint selection, visible focus, readable 16 px note text.
- Inbox quick capture (button or Alt+N) with generated editable title and capture time; no project or notebook needed.
- Standalone notes; notebooks → sections → pages (create, rename, delete when empty, optional empty starter notebooks); move pages anywhere without changing their ID; Trash with restore and delete-forever.
- Growing 1,200 px pages with Fit/100 % zoom; freely positioned rich-text boxes (headings, bold/italic/underline/strike, inline code, lists, quotes, links) and images.
- Screenshot paste (Ctrl+V), text paste, image file picker, drag-and-drop; placement that avoids covering content.
- Move/resize by mouse, keyboard, or numeric fields; bring to front/back; duplicate; delete; per-page undo/redo.
- Autosave with honest Saved / Saving / Unsaved / Not saved status, retry with backoff, error banner, close warning.
- Local attachment storage (bytes + SHA-256); persistent-storage request with the real result shown.
- Single-editor lock across windows; read-only windows follow saved changes; "Edit here instead".
- Backups: folder selection, manual and automatic (30 min while open with changes) snapshots, keep newest 10, prune only after success, last-success/last-error status, reconnect flow, download fallback, crash guard for an unreadable saved folder.
- Restore from file or from the backup folder: full validation, summary review, safety copy first, all-or-nothing replace.
- Offline after first visit; accurate "Offline ready"; "Save and update" for new versions; installable manifest and icons; relative paths for any stable HTTPS host.

### Review fixes (0.1.1)
1. **Handover refused when work cannot be saved.** The editor freezes edits and saves before releasing; if saving fails it replies "refused", keeps the lock, and keeps editing with its changes intact. A thrown save error counts as a refusal. The requester only steals from a window that never acknowledges (frozen).
2. **Ownership enforced everywhere.** A stolen lock (or a commit refused by storage) makes the window read-only, cancels queued saves and retries, and stops backups. Storage now checks an owner token on every commit and restore, so stale retries from an old window are refused. Unsaved changes are held in memory with a banner: "Edit here and save them" (saved on top of the latest data) or "Discard them".
3. **Trashed pages of deleted sections.** Deleting a section/notebook moves its trashed pages' location to the Inbox. IndexedDB migration 1 → 2 repairs existing data; version-1 backups containing the orphan now restore (the page goes to the Inbox, with a warning). Live orphans are still rejected.
4. **Backups track revisions, not timestamps.** Each commit increments a stored revision in the same transaction; each snapshot records the revision it captured, read with the archived data. The interval uses a monotonic clock within a session; a clock set backwards counts as due.
5. Also found and fixed while testing: after taking editing back, the page could briefly reload without the edit that was mid-save (held edits are now saved before reloading, and in-flight saves are overlaid).

### Held-edit recovery fix (0.1.2)
The recheck of `0f28457` found that taking editing back replayed held changes as whole stale records (a body edit also carries its page record), which could revert a newer title or resurrect a trashed page's old live location in a deleted section (and then fail backup validation). Now:
- Held changes keep the stored version they were based on, and are **merged field by field** with the latest stored data. Only fields this window actually changed are applied; newer titles, locations, Trash state, and unrelated content are preserved.
- Conflicts (same field changed in both windows), edits to records deleted elsewhere, blocked deletions, and moves into deleted sections are **not applied in place**: they go to a new **"Recovered changes" page in the Inbox**, and a message says how many.
- Regression tests (`src/store/heldRecovery.test.ts`, 7, fully awaited — no timers): the two reported cases (rename in B; trash + delete notebook in B), same-text conflict, edit to a page deleted forever, conflicting rename, non-conflicting rename alongside B's new content, move into a deleted section. Each ends with a complete backup that passes validation and restores into a clean workspace with the expected result. The browser frozen-window test now also renames the page in B and checks A keeps B's title.

### User-reported checks on real Chrome (Stage 1, before Stage 2 work)
The user reported these passing on their own machine (not re-run here): note and screenshot persistence; real folder backups; Chrome restart and folder reconnection; restore into another Chrome profile; two-window editing handover; launching the installed app with the preview server stopped.

### Stage 2 — projects and reusable knowledge (0.2.0)
Built in checked slices: data model + migrations → store/reconcile/backup wiring and tests → UI → browser tests → docs.
- **Projects:** name, customer, site, job number, status (planned / active / on hold / complete), date-only due date with overdue/soon indicator, description, contacts, equipment, software versions, saved file locations (copyable paths; web links that open only for http/https), and several system categories.
- **Project notes** use the existing page editor with a project owner. Inbox, standalone notes, notebooks, sections, screenshots, and all editing behavior are unchanged. Pages can be moved into or out of a project without changing their ID.
- **Reference library:** categories on notebooks, sections, and pages (pages inherit them). A project suggests every library page that shares a category; projects can pin any other page and hide suggestions (hiding never touches the page). Pinned pages in the Trash are listed and come back when restored.
- **Live links:** a linked page is the original page. It carries a “Reference library — shared page, linked in …” banner naming the projects. **Make a project copy** creates an independent page (new IDs, shared image bytes) labelled “Project copy”, and the project then shows the copy instead of the original.
- **Tags and search:** tags on pages; Settings manages categories and tags (rename, delete with usage counts, starter categories; starter notebooks now get matching categories). Search covers project details, page titles and text, tags, categories, and attachment names, with project, category, tag, type, and include-archived filters.
- **Home dashboard:** active projects (status, customer/site/job, categories, note and reference counts, due state), pinned references, recently edited project notes, recently opened pages, unsorted Inbox count, continue-last-page.
- **Archive and recoverable deletion:** archive/unarchive; project Trash with restore; delete forever moves the project's notes to the page Trash (restorable to the Inbox) and never touches shared library pages. Deleting a page forever removes its pins/hides everywhere and marks copies' source as deleted; deleting a category/tag removes it everywhere.
- **Wiring:** new record stores go through the same change sets, one-transaction autosave, owner-token fencing, revision counter, full backup/restore with validation, and held-edit reconciliation (ID lists merge as sets; dangling links are removed and reported in “Recovered changes”).
- **Migrations:** IndexedDB 2 → 3 (and 1 → 2 → 3) and backup format 1 → 2, keeping every Stage 1 note, ID, attachment, timestamp, layout, and revision. The version-1 trashed-orphan repair still runs for old backups.

### Stage 2 data-safety review (0.2.1)
A focused review of shared references, project copies, archive/Trash/deletion, upgrade and backup compatibility, and two-window editing found four concrete defects. Each was reproduced first (isolated fake-indexeddb workspaces and, for the date field, real Chromium), fixed, and covered by a test that fails without the fix:
1. **A mistyped due-date year made every later backup unrestorable.** Chrome's date field produced `20261-12-15` for a five-digit year; the store accepted it and restore validation then refused the whole backup (“Project #1 is invalid”). Years 0001–0099 (Chrome gives `0099-12-15` for a two-digit year) were also wrongly treated as invalid because `Date.UTC` maps them to 1900–1999. Fixed: correct date-only check for all four-digit years; the store ignores invalid due dates (the previous date stays); the field has `max="9999-12-31"`, which caps the year at four digits in Chrome; and a backup that already contains an invalid due date (possible from 0.2.0) restores with that date cleared and a warning.
2. **A refused held project deletion still moved the project's notes to the Trash.** If window A deleted a project forever while it could not save, and window B then changed that project, taking editing back kept the project (correct) but applied A's “move notes to Trash” part, leaving a live project without its notes.
3. **A refused held category or tag deletion still removed it from every record.** If B renamed the category/tag meanwhile, it was kept but stripped from all notebooks, sections, pages, and projects.
4. **A refused held page deletion still emptied the page and cut its links.** If B renamed the page meanwhile, it was kept but its text boxes and images were deleted, its pins/hides in other projects were removed, and its project copies lost their source link. (The emptied-page part existed since Stage 1.)

Fix for 2–4: `withoutRefusedCascades` in `src/store/reconcile.ts` predicts which held deletions will be refused (with the same rules as before) and drops only the side effects that belonged to them, before anything is merged. Deletions that are not refused behave as before.

Checked and found sound (no change needed): shared-reference edits reaching every linked project; copy independence both ways; project deletion never touching library pages; deleting an original keeping its copy's text and image bytes (assertion added, through a full backup → clean restore); archive/Trash/restore record validity; Stage 1 database and backup upgrades; failed migration and invalid restore preserving the workspace; read-only windows refusing every Stage 2 change (test added); merges of unrelated changes and removal of dangling links.

## Verification

| Check | Result | How |
|---|---|---|
| Baseline at `3af576f` | ✅ | `npm ci`, build, lint, 61 unit tests, 15 browser tests all passed before any Stage 2 change |
| `npm run build` (tsc + Vite) | ✅ | |
| `npm run lint` | ✅ | |
| `npm test` — 90 unit/integration tests | ✅ | 61 from Stage 1 (adapted to format 2) + 24 Stage 2 + 5 from the data-safety review (one Stage 2 test changed: an invalid due date is now repaired on restore instead of rejecting the backup) |
| Migrations (`src/storage/db.test.ts`) | ✅ | DB 1 → 3: revision added, trashed orphan repaired, Stage 2 fields added. DB 2 → 3 with real Stage 1 records: same page/notebook/section IDs, titles, timestamps, object geometry, text, attachment bytes, and revision; Stage 2 features then work and the result backs up and restores. A migration failure (simulated failed write) aborts and leaves the version-2 database untouched |
| Stage 2 proofs (`src/store/projects.test.ts`) | ✅ | **One shared reference updates across two projects** (suggested in one, pinned in the other; edit + reload; both resolve the same page and text). **An independent project copy remains unchanged** when the original is edited, and vice versa (new IDs, shared image bytes). Suggestions by notebook/section/page category; pin/hide/unhide. Archive, trash, restore, delete forever (notes to Trash, library page survives and stays linked elsewhere). Trashed and deleted sources leave no dangling links; after the original is deleted forever, a copy's text and image bytes survive backup → clean restore. Category/tag deletion. Invalid due dates are ignored by the store, and a backup containing one restores with a warning. **Projects, details, links, copies, categories, tags, and attachments survive full backup → clean restore** (every record compared). Broken Stage 2 relationships are rejected. **Stage 1 (format 1) backups** restore with upgraded records |
| Ownership and held edits (`src/store/heldProjects.test.ts`) | ✅ | Fencing refuses a stale project write. Held project edit + other window's rename both survive; pins and hides merge as sets. Conflicting field → other window's value kept, held value in “Recovered changes”. Note created for a project deleted elsewhere goes to the Inbox; edits to the deleted project are recovered, not resurrected. Pin to a page / category deleted elsewhere → link removed and reported. Held project deletion skipped when the other window added a note. Held project copy saved with its objects. **0.2.1:** refused project, category/tag, and page deletions leave the kept record whole (notes stay in the project; assignments stay; content, pins, hides, and copies' source link stay); a read-only window refuses every Stage 2 change and writes nothing. Each ends with a validated backup that restores |
| Search and dates (`src/domain/search.test.ts`) | ✅ | Project details, contacts, software versions, note text, tags, attachment names, accent-insensitive; project/category/tag/kind/archived filters; trashed items excluded; date-only due dates (no time-zone shift), including years 0001–0099 and rejecting five-digit years |
| `npm run test:e2e` — 19 browser tests | ✅ | 15 from Stage 1 (still passing; two expectations adapted to the new restore summary and Home start screen) + 4 in `e2e/projects.spec.ts`, below |
| Stage 2 browser workflow | ✅ | Real Chromium, production build: starter notebooks → library page → project A (category suggestion) and B (pinned) → edit from B, shown in A → **make a project copy** in A and change it → edit original again from B → **copy unchanged**, original changed → reload → tag + search with project filter |
| Stage 2 browser recovery | ✅ | Project details, software, file location, category suggestion, project note with pasted screenshot and tag → archive/unarchive (Home and Archived list) → **download backup → restore in a separate clean browser context** → details, suggestion, text, tag, image SHA-256, search all match → trash → delete forever → note in Trash, shared library page intact |
| Stage 2 two-window check | ✅ | A frozen window with failing writes edits a project field; B takes the lock and renames the project; A is read-only with the edit held (never written); A takes editing back: both changes kept |
| Due-date regression (0.2.1) | ✅ | Real Chromium: a five-digit year typed digit by digit into the due-date field is capped at four digits; the downloaded backup passes restore validation in a clean context. Without the fixes the field stored `20261-12-15` (test fails) |
| Visual check | ✅ (scripted) | Screenshots of Home, project overview, linked reference in a project, search, and a 390 px phone width; no console errors |
| `npm audit --omit=dev` | ✅ 0 | No new dependencies were added in Stage 2 |

### Stage 1 demonstration (`e2e/workflow.spec.ts`) — real browser
Quick note in Inbox → type text and bold it → put a PNG on Chromium's real async clipboard and press Ctrl+V → drag the image and resize from a corner → file a second page in a notebook section → reload → text, image SHA-256, and geometry identical → Download backup → open a **separate clean browser context** → restore the file → text (with bold), image SHA-256, exact geometry, and the notebook › section link all match.

### Real vs. simulated
- **Real in Chromium:** typing, selection, mouse drags, keyboard paths, clipboard paste via Chromium's async clipboard + Ctrl+V, IndexedDB persistence across reload, downloads, file-input restore, Web Locks (including a real lock steal) + BroadcastChannel between two tabs, service worker caching and offline reload (`context.setOffline`), OPFS directory handles for snapshot writing. Stage 2: project editing, category suggestions, pinning, project copies, tags, search, archive/trash/delete, backup → restore in a separate browser context, and the two-window held-edit merge for project data.
- **Simulated:** the Stage 1 → Stage 2 database upgrade (a schema-1/2 database written with fake-indexeddb in unit tests, not an existing Chrome profile), the folder picker (replaced with an origin-private directory handle), permission answers (`queryPermission`/`requestPermission` patched to `prompt`/`denied`/`granted`), write failures (patched `IDBObjectStore.put` and `FileSystemWritableFileStream.write`), disk-full conditions, a frozen tab (that window's BroadcastChannel removed so it never answers), system clock changes (unit tests with injected clocks), and the 0.1.0 database (written with the version-1 schema in fake-indexeddb).
- **Not verifiable here:** this container's headless Chromium closes the page whenever a stored directory handle is read back from IndexedDB, so "the chosen folder is remembered after reload/restart" could not be tested. The crash guard makes such a failure recoverable (the folder is forgotten and the user picks it again), but real Chrome behavior must be checked manually.

## Manual checks still needed (real Chrome on the work laptop)
Stage 1 checks were reported passing by the user (see above). Remaining:
1. **Upgrade the existing workspace:** open the current 0.1.2 workspace with this build (IndexedDB 2 → 3 in real Chrome). Confirm every note, screenshot, notebook, and Trash item is intact, then make a folder backup and restore it in another profile.
2. Restore one of the user's real Stage 1 backup ZIPs (format 1) into a spare profile with this build.
3. Two real Chrome windows: edit project details in one, use “Edit here instead” in the other, and check both directions.
4. File locations: copy a Windows path; open a Dropbox web link (needs a connection).
5. Paste real screenshots (Win+Shift+S / Snipping Tool / Linux tool) into a project note; check size on a high-DPI display.
6. Install/launch the installed app after the update (“Save and update” banner) and confirm it opens offline.
7. Check that the 30-minute folder snapshots continue after the upgrade.
8. If any project due date was entered with 0.2.0, open that project and check the date; a backup made by 0.2.0 that contains an invalid date will restore with that date cleared (the restore review lists it).

## Known limitations
- Stage 1 limitations still apply: held changes live only in that window's memory; no character-level text merge; opening a page can save re-measured text heights; undo is per page and in memory; no multi-select, guides, snapping, alt-text editor, tables, checklists, shapes/annotation, document import, or PDF export; image bytes of deleted objects are kept; backups are built in memory; basic phone layout; folder backups need Chrome/Edge on a desktop and only run while the app is open; restore replaces the whole workspace.
- Project details, categories, tags, pins/hides, archive, and project trash are not in undo history (page Trash and project Trash cover deletion).
- Tags are on pages only (not on projects); categories are on projects, notebooks, sections, and pages.
- Search reads all stored text into memory and is rebuilt after each save; it has not been measured on the 1,000-page synthetic dataset (Stage 5). Original attachment contents are not searched — only their file names.
- Recently opened pages are per device (`localStorage`) and not in backups.
- Local file paths are copied, not opened (browsers cannot open arbitrary local paths). Dropbox links open in a new tab and need a connection.
- A project copy shares image bytes with the original (bytes never change, so the pages stay independent).
- Deleting a page forever also removes it from other projects' pins; there is no per-link history.
- An invalid due date already stored by 0.2.0 stays in this browser's workspace until the date is changed; restores clear it (with a warning).
- Two windows can each create a category or tag with the same name while one cannot save; both are kept (rename or delete one in Settings).
- In a held-edit merge, a pin in one window and a hide of the same page in the other both survive; the page then shows as pinned.
- Tasks, task boards, templates, and a Files tab are Stage 3. Portable project export is Stage 4.
- JavaScript bundle is ~870 KB (≈275 KB gzip), cached after the first visit.

## Next task
**Stage 3 — tasks and project workflow** (see `MINTY_NOTES_PLAN.md` and the handoff's Stage 3 prompt): To do / Doing / Done boards with keyboard move controls, priorities, date-only due dates (reuse `src/domain/dates.ts`), a combined task list, task-to-note links, the project Files tab (building on `Project.fileLocations`), and reusable note/project templates. Adding `Task` (and `Template`) records means `FORMAT_VERSION` 3 / `DB_VERSION` 4 migrations; keep the format 1 → 2 archive migration and the version-1 trashed-orphan repair in `readArchive`.

Before that, do the manual checks above (especially the real 0.1.2 → 0.2.0 upgrade) and fix anything they reveal in this milestone.
