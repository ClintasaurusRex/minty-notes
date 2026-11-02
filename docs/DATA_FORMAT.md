# Minty Notes — data format (version 2)

`FORMAT_VERSION = 2` (`src/domain/types.ts`) versions the record shapes and backups. IndexedDB has its own schema version (`DB_VERSION = 3`, `src/storage/db.ts`). Any change to either needs a migration and a test.

Version 2 (app 0.2.0, Stage 2) adds projects, system categories, tags, project-owned pages, reference links, and project copies. Version-1 data is migrated in place (IndexedDB) or on restore (backups); see “Migrations”.

## IDs and timestamps

- Every record has a stable ID (`crypto.randomUUID()`). IDs never change when a page is renamed or moved. Links always use IDs.
- Timestamps are ISO-8601 UTC strings (`2026-11-01T19:30:00.000Z`).
- Date-only values (a project's due date) are `YYYY-MM-DD` calendar dates. They are never converted to timestamps, so they do not shift with time zones.

## Records

```ts
WorkspaceInfo { workspaceId, formatVersion, createdAt }

Category { id, name, order, createdAt, updatedAt }        // system category, e.g. VTScada
Tag      { id, name, createdAt, updatedAt }               // free label on pages

Project {
  id, name, customer, site, jobNumber, description,
  status: 'planned' | 'active' | 'on-hold' | 'complete',
  dueDate: 'YYYY-MM-DD' | null,                          // four-digit year; the store ignores anything else
  contacts:      { id, name, role, phone, email }[],
  equipment:     { id, name, detail }[],
  software:      { id, name, detail }[],                   // detail = version
  fileLocations: { id, label, kind: 'path' | 'url', value }[],
  categoryIds: string[],                                   // → Category
  pinnedPageIds: string[],                                 // → Page (extra linked references)
  hiddenPageIds: string[],                                 // → Page (suggestions hidden for this project)
  order, archivedAt: string | null, trashedAt: string | null, createdAt, updatedAt
}

Notebook { id, title, order, categoryIds, createdAt, updatedAt }
Section  { id, notebookId, title, order, categoryIds, createdAt, updatedAt }

Page {
  id, title, order, width /* 1200 */, createdAt, updatedAt,
  location: { kind: 'inbox' } | { kind: 'standalone' } | { kind: 'section', sectionId } | { kind: 'project', projectId },
  categoryIds: string[],                                   // the page's own; it also inherits its section's and notebook's
  tagIds: string[],                                        // → Tag
  copiedFrom: { pageId: string | null, title, at } | null, // set on a “project copy”
  trashedAt: string | null
}

CanvasObject = TextObject | ImageObject   // shared: id, pageId, x, y, w, h, z, createdAt, updatedAt
TextObject  { type: 'text',  doc: ProseMirror JSON (TipTap schema) }   // h = measured height
ImageObject { type: 'image', attachmentId, alt }                     // h = displayed height

AttachmentMeta { id, fileName, mimeType, size, sha256, width, height, source: 'paste'|'file'|'drop', createdAt }
```

- Geometry is in page CSS pixels: `x ≥ 0`, `y ≥ 0`, `x + w ≤ page.width`. `z` orders overlaps (higher on top).
- Rich text uses the schema built from `richTextExtensions` (`src/domain/richtext.ts`): paragraph, heading 1–3, bullet/ordered list, blockquote, code block, horizontal rule, hard break; marks bold, italic, underline, strike, code, link (`http`, `https`, `mailto` only).
- A page never needs a project. `location` is its one **owner**. Pages not owned by a project form the **reference library**.
- **Linked references** are not records of their own: a project links to the original page through `pinnedPageIds`, or by **suggestion** — a library page whose effective categories (own ∪ section ∪ notebook) share one with the project, unless it is in `hiddenPageIds`. Because the link is the page ID, an edit to the page shows in every project that links it. Rules live in `src/domain/references.ts`.
- A **project copy** is an ordinary page owned by the project, with new page and object IDs and `copiedFrom` set. Image objects in the copy reuse the original attachment IDs (attachment bytes never change). When the original is deleted forever, `copiedFrom.pageId` becomes `null` (the title is kept).
- Deleting a section/notebook is only allowed when it has no live pages. Its trashed pages are moved to `{ kind: 'inbox' }` (still trashed) at that moment, so no page ever points at a missing section; restoring them puts them in the Inbox.
- **Projects** are archived (`archivedAt`) or trashed (`trashedAt`) without touching their pages. Deleting a trashed project forever moves every page it owns to `{ kind: 'inbox' }` and into the Trash (keeping an earlier `trashedAt`), then removes the project. Library pages it linked are never changed.
- A trashed page stays in `pinnedPageIds` (the pin returns if the page is restored). Deleting a page forever removes it from every project's `pinnedPageIds`/`hiddenPageIds`. Deleting a category or tag removes its ID from every record. So no ID list ever points at a missing record.
- Restoring a trashed page whose section or project is gone (or whose project is in the Trash) puts it in the Inbox.

## IndexedDB layout (`minty-notes`)

| Store | Key | Contents |
|---|---|---|
| `projects`, `categories`, `tags` | `id` | records above (added in DB version 3) |
| `notebooks`, `sections`, `pages` | `id` | records above (`sections.byNotebook` index) |
| `objects` | `id` | canvas objects (`byPage` index) |
| `attachments` | `id` | attachment metadata |
| `blobs` | attachment id | image bytes (`Blob`) |
| `settings` | string key | see below |

Settings keys: `workspace` (WorkspaceInfo — **backed up**), and device-local values that are **not** backed up:

| Key | Contents |
|---|---|
| `activity` | `{ lastChangeAt, revision }` — `revision` increases by 1 in the same transaction as every committed change and every restore |
| `editorOwner` | `{ token, at }` — fencing token of the window allowed to write; commits and restores carrying another token are refused (`OwnershipError`) |
| `backupStatus` | `{ lastBackup: { at, fileName, revision }, lastDownloadAt, lastError }` — `revision` is the stored revision the snapshot captured (read in the same transaction as the archived records) |
| `backupFolder` | directory handle — never portable |
| `safeguard` | pre-restore ZIP |
| `ui` | reserved |

UI conveniences (last section, page, and project; recently opened pages `minty:recent`) are in `localStorage` (`minty:*`). They are per device and not backed up.

### IndexedDB versions

| `DB_VERSION` | App | Change |
|---|---|---|
| 1 | 0.1.0 | Initial stores. |
| 2 | 0.1.1 | No new stores. Migration (one upgrade transaction, aborted as a whole on error): add `activity.revision` (1 if `lastChangeAt` was set, else 0); move any page whose section no longer exists to `{ kind: 'inbox' }` (the trashed-page orphan left by 0.1.0). Status saved by 0.1.0 has no `lastBackup.revision`; it is treated as “not known to be backed up”, so one extra snapshot is written. |
| 3 | 0.2.0 | New stores `projects`, `categories`, `tags`. Migration (same upgrade transaction; a database at version 1 runs the version-2 step first): every page gets `categoryIds: []`, `tagIds: []`, `copiedFrom: null`; every notebook and section gets `categoryIds: []`; `workspace.formatVersion` becomes 2. IDs, titles, timestamps, locations, objects, attachments, and the revision are unchanged. Any failure aborts the upgrade and leaves the older database as it was (tested). |

## Backup archive

File name: `minty-notes-backup-YYYYMMDD-HHMMSSZ.zip` (UTC; `-2`, `-3`… if taken). Safety copies: `minty-notes-before-restore-…zip`.

```
manifest.json
records.json                 { workspace, projects, categories, tags, notebooks, sections, pages, objects, attachments }
attachments/<id>.<ext>       original bytes (stored, not recompressed)
README.txt
```

`manifest.json`:

```json
{
  "format": "minty-notes-backup",
  "formatVersion": 2,
  "app": { "name": "Minty Notes", "version": "0.2.0" },
  "createdAt": "…",
  "workspaceId": "…",
  "counts": { "projects": 0, "categories": 0, "tags": 0, "notebooks": 0, "sections": 0, "pages": 0, "objects": 0, "attachments": 0 },
  "records": { "path": "records.json", "size": 0, "sha256": "…" },
  "files": [{ "attachmentId": "…", "path": "attachments/….png", "size": 0, "sha256": "…", "mimeType": "image/png" }]
}
```

Before validation, version-1 archives (apps 0.1.0–0.1.2) are upgraded in `readArchive`:
1. One known repair: a **trashed** page whose section is missing (written by app 0.1.0 after deleting that section or notebook) gets location `{ kind: 'inbox' }`, with a warning in the restore review. A live page pointing at a missing section is still rejected.
2. `migrateRecordsV1toV2`: add empty `projects`, `categories`, `tags`; add `categoryIds: []` to notebooks and sections; add `categoryIds: []`, `tagIds: []`, `copiedFrom: null` to pages; set `workspace.formatVersion` to 2. Nothing else changes.

Every archive (any version) also gets one repair: a project `dueDate` that is a string but not a valid `YYYY-MM-DD` date (app 0.2.0 could store e.g. `20261-12-15` from Chrome's date field) is set to `null`, with a warning naming the project and the value, instead of refusing the whole backup.

Restore rejects the archive (and changes nothing) if any of these fail: ZIP readable; total ≤ 4 GiB and ≤ 200,000 entries; format name; `1 ≤ formatVersion ≤ FORMAT_VERSION`; `records.json` checksum; record shapes and timestamps; unique IDs; project fields (known status, valid `YYYY-MM-DD` due date or null, list item shapes, `path`/`url` kinds); section → notebook, page → section, page → project, object → page, image → attachment, project/notebook/section/page → category, page → tag, pinned/hidden → page, and `copiedFrom.pageId` → page (when not null) links; rich text valid for the schema; every attachment present with matching size and SHA-256. Unsafe paths (`..`, absolute, `\`) and unknown files are ignored with a warning.

A full backup is a complete working copy. It is not a redacted or share-safe export.

## Migrations

- Older archive versions are migrated in `readArchive` before validation (format 1 → 2 above); newer ones are refused with "update the app".
- Tests: `src/storage/db.test.ts` (DB 1 → 3 and 2 → 3 with Stage 1 notes, IDs, layout, and attachment bytes; failed migration leaves version 2 untouched), `src/store/projects.test.ts` and `src/backup/backup.test.ts` (format-1 archives, including the trashed-orphan repair).
- Held-edit reconciliation (`src/store/reconcile.ts`) treats `categoryIds`, `tagIds`, `pinnedPageIds`, and `hiddenPageIds` as sets (both windows' additions and removals are kept) and finally removes any ID that points at a record deleted in either window.
- IndexedDB upgrades go in `openMintyDB`'s `upgrade` callback, keyed on `oldVersion`. Another open window is told to reload (`blocking`).
