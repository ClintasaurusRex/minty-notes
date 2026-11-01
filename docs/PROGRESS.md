# Minty Notes — progress

Last updated: November 1, 2026 · Branch: `claude/great-gauss-e9zx88` · App version 0.1.0

## Status

**Stage 0 and Stage 1 are complete and checked.** Stages 2–6 have not started. Nothing has been deployed.

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

## Verification

| Check | Result | How |
|---|---|---|
| `npm ci` | ✅ | baseline at start |
| `npm run build` (tsc + Vite) | ✅ | |
| `npm run lint` | ✅ | |
| `npm test` — 32 unit/integration tests | ✅ | Vitest + fake-indexeddb: geometry, autosave, failed/retried writes, undo model, archive validation (bad ZIP, wrong format, newer version, tampered records, damaged/missing images, broken links, invalid rich text, duplicates, unsafe paths), restore round trip, restore failure keeps data, snapshot retention, write failure keeps old snapshots, denied/revoked permission, auto-snapshot timing, read-only windows, crash guard |
| `npm run test:e2e` — 13 browser tests | ✅ | Real headless Chromium against the production build (see below) |
| Save-then-update flow | ✅ (scripted) | New build published under a running app → banner → edits typed just before updating were saved → new version loaded |
| Heavy page timing | ✅ (scripted) | `scripts/heavy-page-check.mjs`: 85 text + 15 images open ≈ 0.53 s; keystroke ≈ 8 ms; pointer move ≈ 17 ms (4 vCPU cloud container) |
| `npm audit --omit=dev` | ✅ 0 | 12 moderate advisories remain in dev-only lint tooling (`minimatch` via ESLint/typescript-eslint), present before this work; the only automated fix is a breaking downgrade, so left as is |

### Required demonstration (`e2e/workflow.spec.ts`) — real browser
Quick note in Inbox → type text and bold it → put a PNG on Chromium's real async clipboard and press Ctrl+V → drag the image and resize from a corner → file a second page in a notebook section → reload → text, image SHA-256, and geometry identical → Download backup → open a **separate clean browser context** → restore the file → text (with bold), image SHA-256, exact geometry, and the notebook › section link all match.

### Real vs. simulated
- **Real in Chromium:** typing, selection, mouse drags, keyboard paths, clipboard paste via Chromium's async clipboard + Ctrl+V, IndexedDB persistence across reload, downloads, file-input restore, Web Locks + BroadcastChannel between two tabs, service worker caching and offline reload (`context.setOffline`), OPFS directory handles for snapshot writing.
- **Simulated:** the folder picker (replaced with an origin-private directory handle), permission answers (`queryPermission`/`requestPermission` patched to `prompt`/`denied`/`granted`), write failures (patched `IDBObjectStore.put` and `FileSystemWritableFileStream.write`), disk-full conditions.
- **Not verifiable here:** this container's headless Chromium closes the page whenever a stored directory handle is read back from IndexedDB, so "the chosen folder is remembered after reload/restart" could not be tested. The crash guard makes such a failure recoverable (the folder is forgotten and the user picks it again), but real Chrome behavior must be checked manually.

## Manual checks still needed (real Chrome on the work laptop)
1. Choose a backup folder through Chrome's real picker (ideally inside Dropbox); confirm a ZIP appears and Settings shows it.
2. Close Chrome fully, reopen Minty Notes: the folder should be remembered; Chrome may ask again — use "Reconnect folder" (and try Chrome's "Allow on every visit" if offered). Confirm no crash and that snapshots continue.
3. Paste real screenshots: Win+Shift+S / Snipping Tool / Print Screen (Windows) and the Linux screenshot tool. Check the image size looks right on a high-DPI display.
4. Install from Chrome's address bar, then launch the installed app offline.
5. Restore one of the real folder snapshots in a different Chrome profile.
6. Check what Settings reports for persistent storage on that machine.

## Known limitations (Stage 1)
- Undo history is per page and in memory; it is cleared on reload. Notebook/page management is not undoable (Trash covers page deletion).
- No multi-select, alignment guides, or snapping yet. No image alt-text editor. No search, tags, projects, tasks, tables, checklists, shapes/annotation, document import, or PDF export (later stages).
- Image bytes of deleted image objects stay stored (and in backups) until a cleanup feature exists.
- Backups are built in memory; very large workspaces may need streaming (Stage 5).
- Phone layout is basic: the page list overlays the page and wide pages are scaled down; reading/quick-capture polish is Stage 5.
- Folder backups need Chrome or Edge on a desktop; other browsers use downloads. No backups happen while the app is closed.
- Restore replaces the whole workspace (merge is later scope). Changing the hosting address needs backup → restore.
- JavaScript bundle is ~760 KB (≈245 KB gzip), cached after the first visit.

## Next task
**Stage 2 — projects and reusable knowledge** (see `MINTY_NOTES_PLAN.md` and the handoff's Stage 2 prompt). Start by adding a `Project` record and `{ kind: 'project', projectId }` page location with a format/DB migration (bump `FORMAT_VERSION` to 2 with an archive migration from 1), then project details, system categories, linked reference pages, suggestions, pin/hide, project copies, tags, search, home dashboard, archive. Keep general notes fully usable and prove shared-reference vs. project-copy behavior.

Before that, do the manual checks above and fix anything they reveal in this milestone.
