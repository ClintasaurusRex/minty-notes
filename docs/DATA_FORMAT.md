# Minty Notes — data format (version 3)

`FORMAT_VERSION = 3` (`src/domain/types.ts`) versions the record shapes and backups. IndexedDB has its own schema version (`DB_VERSION = 4`, `src/storage/db.ts`). Any change to either needs a migration and a test.

Version 2 (app 0.2.0, Stage 2) added projects, system categories, tags, project-owned pages, reference links, and project copies. Version 3 (app 0.3.0, Stage 3) adds **tasks**, **templates**, and a `description` on project file locations. Older data is migrated in place (IndexedDB) or on restore (backups); see “Migrations”.

## IDs and timestamps

- Every record has a stable ID (`crypto.randomUUID()`). IDs never change when a page is renamed or moved. Links always use IDs.
- Timestamps are ISO-8601 UTC strings (`2026-11-01T19:30:00.000Z`).
- Date-only values (project and task due dates) are `YYYY-MM-DD` calendar dates with a four-digit year. They are never converted to timestamps, so they do not shift with time zones; “overdue / today / soon” compares them with today's date in the local calendar.

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
  fileLocations: { id, label, kind: 'path' | 'url', value, description }[],   // description: format 3
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

// Format 3
Task {
  id, projectId,                                           // → Project (required: a task belongs to one project)
  title, description,                                      // plain text
  status: 'todo' | 'doing' | 'done',
  priority: 'low' | 'normal' | 'high' | 'urgent',
  dueDate: 'YYYY-MM-DD' | null,                            // four-digit year; the store ignores anything else
  linkedPageIds: string[],                                 // → Page (any page; links, never copies)
  order,                                                   // position within its status column
  completedAt: string | null,                              // set while status is 'done'
  createdAt, updatedAt
}

Template {
  id, kind: 'note' | 'project', name, description,
  notes: TemplateNote[],                                   // exactly one for a note template
  project: TemplateProject | null,                         // project templates only
  tasks: TemplateTask[],                                   // project templates only (empty for notes)
  createdAt, updatedAt
}
TemplateNote    { title, categoryIds, tagIds, objects: TemplateObject[] }
TemplateObject  = { type: 'text', x, y, w, h, z, doc } | { type: 'image', x, y, w, h, z, attachmentId, alt }   // no IDs
TemplateProject { status, description, categoryIds, pinnedPageIds, equipment, software, fileLocations }
TemplateTask    { title, description, priority, noteIndexes: number[] /* → notes[i] */, pageIds: string[] /* → library Page */ }
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
- **Tasks** belong to one project and are ordered per status column (`order` 1..n; moves renumber that column). Moving into Done sets `completedAt`; moving out clears it. A task links notes by page ID (`linkedPageIds`): moving a page keeps the link; a trashed page keeps the link (shown as “in the Trash”, it returns when restored); **deleting a page forever removes it from every task's `linkedPageIds`** and from every template. Tasks of an archived project are kept and hidden from the combined list unless “Include archived projects” is on; tasks of a trashed project are hidden everywhere until it is restored. **Deleting a project forever deletes its tasks** (the confirmation says how many); its notes go to the page Trash as before, so other projects' task links to them stay valid.
- **Templates** are snapshots without record IDs. Using one creates new pages, objects, tasks, and projects with fresh IDs (`createPageFromTemplate`, `createProjectFromTemplate`); nothing generated refers back to the template, and deleting or changing a template never touches what was made from it. Image objects reuse the template's attachment IDs (bytes never change, like project copies). Library-page links (`TemplateProject.pinnedPageIds`, `TemplateTask.pageIds`) stay links to the shared original. Task links to the template's own notes use `noteIndexes` and become links to the newly created notes. A project template leaves out customer, site, job number, contacts, due dates, and task status (new tasks start in To do). Deleting a page forever, a category, or a tag removes its ID from every template, so templates never point at missing records.

## IndexedDB layout (`minty-notes`)

| Store | Key | Contents |
|---|---|---|
| `projects`, `categories`, `tags` | `id` | records above (added in DB version 3) |
| `tasks` | `id` | tasks (`byProject` index; added in DB version 4) |
| `templates` | `id` | templates (added in DB version 4) |
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
| 4 | 0.3.0 | New stores `tasks` (`byProject` index) and `templates`. Migration (same upgrade transaction, after the earlier steps for older databases): every project file location gets `description: ''`; `workspace.formatVersion` becomes 3. Project `updatedAt`, IDs, notes, objects, attachments, and the revision are unchanged. Any failure aborts the upgrade and leaves the version-3 database as it was (tested). |

## Backup archive

File name: `minty-notes-backup-YYYYMMDD-HHMMSSZ.zip` (UTC; `-2`, `-3`… if taken). Safety copies: `minty-notes-before-restore-…zip`.

```
manifest.json
records.json                 { workspace, projects, tasks, templates, categories, tags, notebooks, sections, pages, objects, attachments }
attachments/<id>.<ext>       original bytes (stored, not recompressed)
README.txt
```

`manifest.json`:

```json
{
  "format": "minty-notes-backup",
  "formatVersion": 3,
  "app": { "name": "Minty Notes", "version": "0.3.0" },
  "createdAt": "…",
  "workspaceId": "…",
  "counts": { "projects": 0, "tasks": 0, "templates": 0, "categories": 0, "tags": 0, "notebooks": 0, "sections": 0, "pages": 0, "objects": 0, "attachments": 0 },
  "records": { "path": "records.json", "size": 0, "sha256": "…" },
  "files": [{ "attachmentId": "…", "path": "attachments/….png", "size": 0, "sha256": "…", "mimeType": "image/png" }]
}
```

Before validation, version-1 archives (apps 0.1.0–0.1.2) are upgraded in `readArchive`:
1. One known repair: a **trashed** page whose section is missing (written by app 0.1.0 after deleting that section or notebook) gets location `{ kind: 'inbox' }`, with a warning in the restore review. A live page pointing at a missing section is still rejected.
2. `migrateRecordsV1toV2`: add empty `projects`, `categories`, `tags`; add `categoryIds: []` to notebooks and sections; add `categoryIds: []`, `tagIds: []`, `copiedFrom: null` to pages; set `workspace.formatVersion` to 2. Nothing else changes.

Then version-1 and version-2 archives (apps 0.1.0–0.2.1) are upgraded with `migrateRecordsV2toV3`: add empty `tasks` and `templates`; add `description: ''` to every project file location; set `workspace.formatVersion` to 3. Nothing else changes.

Every archive (any version) also gets one repair: a project or task `dueDate` that is a string but not a valid `YYYY-MM-DD` date (app 0.2.0 could store e.g. `20261-12-15` from Chrome's date field) is set to `null`, with a warning naming the project or task and the value, instead of refusing the whole backup.

Restore rejects the archive (and changes nothing) if any of these fail: ZIP readable; total ≤ 4 GiB and ≤ 200,000 entries; format name; `1 ≤ formatVersion ≤ FORMAT_VERSION`; `records.json` checksum; record shapes and timestamps; unique IDs; project fields (known status, valid `YYYY-MM-DD` due date or null, list item shapes including file-location descriptions, `path`/`url` kinds); task fields (known status and priority, valid due date or null, numeric order) and task → project and task → linked page links; template shape (kind, exactly one note in a note template, project settings only in project templates), template text valid for the schema, template image → attachment, template → category/tag/page links, and template task `noteIndexes` within range; section → notebook, page → section, page → project, object → page, image → attachment, project/notebook/section/page → category, page → tag, pinned/hidden → page, and `copiedFrom.pageId` → page (when not null) links; rich text valid for the schema; every attachment present with matching size and SHA-256. Unsafe paths (`..`, absolute, `\`) and unknown files are ignored with a warning.

A full backup is a complete working copy. It is not a redacted or share-safe export.

## Migrations

- Older archive versions are migrated in `readArchive` before validation (format 1 → 2 above); newer ones are refused with "update the app".
- Older archive versions are migrated in order: format 1 → 2 → 3.
- Tests: `src/storage/db.test.ts` (DB 1 → 4 and 2 → 4 with Stage 1 notes, IDs, layout, and attachment bytes; DB 3 → 4 with Stage 2 projects, links, and file locations; a failed migration leaves version 2 or version 3 untouched), `src/store/projects.test.ts`, `src/store/tasks.test.ts`, and `src/backup/backup.test.ts` (format-1 and format-2 archives, including the trashed-orphan and invalid-due-date repairs).
- Held-edit reconciliation (`src/store/reconcile.ts`) treats `categoryIds`, `tagIds`, `pinnedPageIds`, `hiddenPageIds`, and a task's `linkedPageIds` as sets (both windows' additions and removals are kept) and finally removes any ID that points at a record deleted in either window, including task links and template references. Template fields (`notes`, `tasks`, `project`) merge as whole fields.
- IndexedDB upgrades go in `openMintyDB`'s `upgrade` callback, keyed on `oldVersion`. Another open window is told to reload (`blocking`).
