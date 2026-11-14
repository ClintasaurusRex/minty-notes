# Minty Notes — data format (version 4)

`FORMAT_VERSION = 4` (`src/domain/types.ts`) versions the record shapes and backups. IndexedDB has its own schema version (`DB_VERSION = 5`, `src/storage/db.ts`). Any change to either needs a migration and a test.

Version 2 (app 0.2.0, Stage 2) added projects, system categories, tags, project-owned pages, reference links, and project copies. Version 3 (app 0.3.0, Stage 3) added **tasks**, **templates**, and a `description` on project file locations. Version 4 (app 0.4.0, Stage 4 slices 1–3) adds **tables** and **internal page links** in rich text, **image markup** (`ImageObject.markup`), **sketch** objects, and **imported documents** (`Page.importedFrom`, attachments with `source: 'import'`). Every format-4 field is optional or a new object type, so no stored record is rewritten. Older data is migrated in place (IndexedDB) or on restore (backups); see “Migrations”.

App 0.4.1 (Stage 4 slice 4, note-to-PDF export) **changes no stored record, no IndexedDB store, and no backup**: format 4 / IndexedDB 5 are unchanged, and 0.4.0 and 0.4.1 read each other's data and backups. A PDF export only reads the workspace; the PDF file is not stored. The only new local value is the per-device export preference in `localStorage` (below).

App 0.4.2 (Stage 4 slice 5, portable project export/import) also **changes no stored record, no IndexedDB store, and no backup**: format 4 / IndexedDB 5 are unchanged, and 0.4.0–0.4.2 read each other's data and backups. It adds a second file format, the **portable project package** (its own section below, with its own version number), and one new way of writing: an import **adds** records in a single transaction and never replaces any. An imported project consists only of ordinary format-4 records.

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
  trashedAt: string | null,
  importedFrom?: ImportedFrom                              // format 4: set on a draft made from an imported document
}

CanvasObject = TextObject | ImageObject | SketchObject   // shared: id, pageId, x, y, w, h, z, createdAt, updatedAt
TextObject   { type: 'text',  doc: ProseMirror JSON (TipTap schema) }   // h = measured height
ImageObject  { type: 'image', attachmentId, alt, markup?: Markup }     // h = displayed height; markup: format 4, absent = none
SketchObject { type: 'sketch', markup: Markup }                        // format 4; markup.crop is always null

// Format 4 — annotations, in the markup's own coordinates (image: natural pixels; sketch: drawing size)
Markup     { width, height, crop: { x, y, w, h } | null, items: Annotation[] }   // crop: visible part, non-destructive
Annotation =
  | { id, kind: 'arrow' | 'line',        x1, y1, x2, y2, color, width }
  | { id, kind: 'rect' | 'ellipse',      x, y, w, h, color, width, fill: color | null }
  | { id, kind: 'text',                  x, y, text, color, size, background: color | null }   // x, y = top-left
  | { id, kind: 'pen' | 'highlighter',   points: number[] /* x,y,x,y… */, color, width }
  | { id, kind: 'blur' | 'redact',       x, y, w, h }
// color = '#rrggbb'. Items draw in order, except blur and redact areas, which always draw first (under the others).

AttachmentMeta { id, fileName, mimeType, size, sha256, width, height, source: 'paste'|'file'|'drop'|'import', createdAt }   // 'import': format 4

// Format 4 — the original behind an imported draft
ImportedFrom { attachmentId /* → AttachmentMeta, the unchanged original */, fileName, format: 'docx' | 'pdf', importedAt, notes: string[] /* what did not convert */ }

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
TemplateObject  = { type: 'text', x, y, w, h, z, doc } | { type: 'image', x, y, w, h, z, attachmentId, alt, markup? } | { type: 'sketch', x, y, w, h, z, markup }   // no IDs
TemplateProject { status, description, categoryIds, pinnedPageIds, equipment, software, fileLocations }
TemplateTask    { title, description, priority, noteIndexes: number[] /* → notes[i] */, pageIds: string[] /* → library Page */ }
```

- Geometry is in page CSS pixels: `x ≥ 0`, `y ≥ 0`, `x + w ≤ page.width`. `z` orders overlaps (higher on top).
- Rich text uses the schema built from `richTextExtensions` (`src/domain/richtext.ts`): paragraph, heading 1–3, bullet/ordered list, blockquote, code block, horizontal rule, hard break; marks bold, italic, underline, strike, code, link (`http`, `https`, `mailto` only when typed or pasted; rendering refuses unsafe schemes). **Format 4** adds `table` → `tableRow` → `tableHeader`/`tableCell` (attributes `colspan` and `rowspan` 1–50, `colwidth` null or ≤ 50 numbers 0–10,000, `align`; pasted or imported cells always get bounded spans and no column widths) and the `pageLink` mark (`{ pageId }`).
- **Page links** are marks on the user's own text: `{ type: 'pageLink', attrs: { pageId } }`. The destination's title and state are looked up when shown, so moving or renaming the target never breaks the link. A link to a trashed page is shown “in Trash” (following it offers to restore the page). **A link to a page deleted forever is kept** (the text stays, shown as “deleted”); it is the one ID in the workspace allowed to point at a missing record, so a backup is never refused for it — restore lists how many notes and templates contain such links. Project copies and templates keep links to the same pages (links inside a project template are not remapped to the new notes).
- **Image markup** never changes the attachment bytes. `crop` only chooses what is shown; resizing the image object scales the markup with it. **`blur` is visual only and `redact` is an opaque cover drawn on screen: the stored original keeps every pixel, and so do backups.** Only a flattened PNG copy (“Save PNG copy”) replaces redacted pixels with solid black (`#000000`) and pixelates blurred areas; nothing outside the crop is in that file. Label text is included in search.
- **Imported documents:** the original file is an ordinary attachment (`source: 'import'`, `mimeType` `application/pdf` or the DOCX type) that is never changed; the draft page points at it with `importedFrom`. Pictures taken from a DOCX are image attachments with `source: 'import'`. **Original only:** when a real DOCX/PDF cannot be converted (scanned, damaged, password-protected) and the user keeps it, the page stores the reason as its only note, worded `“<fileName>” could not be converted: <why>.` (`notConvertedReason`, `src/import/formats.ts`). Since 0.4.1 the app recognises such pages from that wording (`isOriginalOnly`) and labels them “Original file only — not converted” instead of “Imported draft”; no field was added, so pages kept by 0.4.0 are recognised too. Deleting the page forever keeps the attachment bytes (like images of deleted objects). A project copy keeps `importedFrom` (same original).
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
| `blobs` | attachment id | attachment bytes (`Blob`): images and imported original documents |
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

UI conveniences (last section, page, and project; recently opened pages `minty:recent`; PDF export options `minty:pdf-export` = `{ paper: 'letter' | 'a4', orientation: 'auto' | 'portrait' | 'landscape', theme: 'light' | 'dark' }`, since 0.4.1) are in `localStorage` (`minty:*`). They are per device and not backed up; unreadable values fall back to defaults.

### IndexedDB versions

| `DB_VERSION` | App | Change |
|---|---|---|
| 1 | 0.1.0 | Initial stores. |
| 2 | 0.1.1 | No new stores. Migration (one upgrade transaction, aborted as a whole on error): add `activity.revision` (1 if `lastChangeAt` was set, else 0); move any page whose section no longer exists to `{ kind: 'inbox' }` (the trashed-page orphan left by 0.1.0). Status saved by 0.1.0 has no `lastBackup.revision`; it is treated as “not known to be backed up”, so one extra snapshot is written. |
| 3 | 0.2.0 | New stores `projects`, `categories`, `tags`. Migration (same upgrade transaction; a database at version 1 runs the version-2 step first): every page gets `categoryIds: []`, `tagIds: []`, `copiedFrom: null`; every notebook and section gets `categoryIds: []`; `workspace.formatVersion` becomes 2. IDs, titles, timestamps, locations, objects, attachments, and the revision are unchanged. Any failure aborts the upgrade and leaves the older database as it was (tested). |
| 4 | 0.3.0 | New stores `tasks` (`byProject` index) and `templates`. Migration (same upgrade transaction, after the earlier steps for older databases): every project file location gets `description: ''`; `workspace.formatVersion` becomes 3. Project `updatedAt`, IDs, notes, objects, attachments, and the revision are unchanged. Any failure aborts the upgrade and leaves the version-3 database as it was (tested). |
| 5 | 0.4.0 | No new stores and no record rewrites (format-4 fields are optional). Migration (same upgrade transaction, after the earlier steps): `workspace.formatVersion` becomes 4. The version bump matters on its own: an older cached app (DB version 4) can no longer open the database, so it cannot edit — and silently drop — tables, page links, markup, sketches, or imports it does not understand. Every Stage 3 record is kept byte for byte (tested); a failed upgrade leaves the version-4 database untouched (tested). |

## Backup archive

File name: `minty-notes-backup-YYYYMMDD-HHMMSSZ.zip` (UTC; `-2`, `-3`… if taken). Safety copies: `minty-notes-before-restore-…zip`.

```
manifest.json
records.json                 { workspace, projects, tasks, templates, categories, tags, notebooks, sections, pages, objects, attachments }
attachments/<id>.<ext>       original bytes (stored, not recompressed): images, and imported originals as .pdf / .docx
README.txt
```

`manifest.json`:

```json
{
  "format": "minty-notes-backup",
  "formatVersion": 4,
  "app": { "name": "Minty Notes", "version": "0.4.0" },
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

Then version-1 to version-3 archives (apps 0.1.0–0.3.0) are upgraded with `migrateRecordsV3toV4`: `workspace.formatVersion` becomes 4; no record changes (format 4 only adds optional fields, new rich-text content, and a new object type).

Every archive (any version) also gets one repair: a project or task `dueDate` that is a string but not a valid `YYYY-MM-DD` date (app 0.2.0 could store e.g. `20261-12-15` from Chrome's date field) is set to `null`, with a warning naming the project or task and the value, instead of refusing the whole backup.

Restore rejects the archive (and changes nothing) if any of these fail: the ZIP structure (below); total ≤ 4 GiB and ≤ 200,000 entries; `manifest.json` ≤ 64 MB and `records.json` ≤ 512 MB; format name; `1 ≤ formatVersion ≤ FORMAT_VERSION`; `records.json` checksum; record shapes and timestamps; unique IDs; project fields (known status, valid `YYYY-MM-DD` due date or null, list item shapes including file-location descriptions, `path`/`url` kinds); task fields (known status and priority, valid due date or null, numeric order) and task → project and task → linked page links; template shape (kind, exactly one note in a note template, project settings only in project templates), template text valid for the schema, template image → attachment, template → category/tag/page links, and template task `noteIndexes` within range; **format 4:** table cell spans and widths, `pageLink` and `link` mark attributes, image `markup` and `sketch` markup (size 1–20,000; crop inside the image, never on a sketch; ≤ 2,000 items; known kinds; finite coordinates; `#rrggbb` colours; labels ≤ 2,000 characters; pen strokes ≤ 20,000 values; unique item IDs), in objects and in templates; page `importedFrom` (shape, `docx`/`pdf`, ≤ 100 notes) → attachment; section → notebook, page → section, page → project, object → page, image → attachment, project/notebook/section/page → category, page → tag, pinned/hidden → page, and `copiedFrom.pageId` → page (when not null) links; rich text valid for the schema; every attachment present with matching size and SHA-256, each from its own file. Unknown files are ignored with a warning (at most 10 named, the rest counted) and never unpacked; folders are skipped.

**Reading the ZIP of a backup** (since 0.4.2's second audit; code: `readArchive` in `src/backup/archive.ts` with `src/backup/zipReader.ts`, the same reader as Word documents and project packages). The file is untrusted until checked, in this order — nothing is decompressed before step 3:

1. **Structure, from the directory and the fixed-size headers only.** An end record that reaches exactly to the end of the file (an archive comment is fine; two end records that both fit are refused); not split over volumes; at most 200,000 entries, judged from the count alone; the directory fills exactly the space before the end record. For every entry: its header in front of the data lies inside the file, before the directory, and repeats the directory's name, method, CRC, and sizes (with a data descriptor the header may hold zeros instead); a stored entry's two sizes are equal; its data ends before the directory; no two entries overlap. Data descriptors, extra fields, file comments, gaps between entries, and ZIP64 records (with their 64-bit sizes checked the same way) are accepted, because ZIP tools write them when a backup is unpacked and zipped again. Encrypted entries are refused.
2. **Names.** The same name twice refuses the backup (which copy would count?), and so does an unsafe path (`..`, absolute, `\`, drive letter, control characters) — until 0.4.2 such paths were ignored with a warning; no backup Minty Notes writes contains one.
3. **Sizes, then unpacking.** The declared sizes of `manifest.json`, `records.json`, and `attachments/` add up to ≤ 4 GiB. Exactly one `manifest.json` is unpacked (≤ 64 MB); then `records.json`, whose size must equal the manifest's `records.size` before it is unpacked (≤ 512 MB: the writer first holds all records as one JavaScript string, which Chrome caps at 536,870,888 characters, so only hundreds of millions of characters of non-Latin text could ever make a larger one); then each attachment that a record uses, each from its own file (two attachments listing one file is refused), at most once, the first damaged file ending the check. Unpacking is bounded by real bytes: a stored file is read in place; a compressed one (only `manifest.json` and `records.json` in backups Minty Notes writes; also attachments in repacked ones) is inflated a little at a time, refused within about 1 MiB of passing its recorded size, and refused afterwards if it came out shorter or its CRC-32 differs; a recorded size deflate cannot produce from that many bytes (> 1032 : 1) is refused without inflating. `README.txt` and unknown files are never unpacked.

**Compatibility of backup files.** Every release has written backups with the same call (`fflate` 0.8.3 `zip`: attachments stored, the three text files deflated, no extra fields, no comments), so the ZIP layout of a backup has not changed since 0.1.0. Tested with one backup written by each release's own code (0.1.0, 0.1.1, 0.1.2, 0.2.0, 0.2.1, 0.3.0, 0.4.0, 0.4.1 — `src/test/files/backups/`, made from the release commits with `git archive`) and with a backup zipped again by Info-ZIP (folders, extra fields, comment; data descriptors; ZIP64 records), 7-Zip, and Python: all restore completely (`src/backup/archiveCompat.test.ts`, and in Chromium `e2e/archiveSafety.spec.ts`). A known limit of that writer, from 0.1.0 on: past 65,535 entries (more than 65,532 attachments) it writes a wrong entry count, so such a backup was never restorable; the reader refuses it as damaged instead of reading part of it.

A full backup is a complete working copy. It is not a redacted or share-safe export. A portable project package is refused here with a pointer to “Import project” (and the other way round).

## Portable project package (package version 1)

One project with what it needs, for moving to another computer or a coworker. **It is not a backup**: importing it adds one new project and never replaces or changes anything (code: `src/portable/`). File name: `minty-project-<project name>-YYYYMMDD-HHMMSSZ.zip` (UTC) — deliberately not the snapshot pattern `minty-notes-backup-…`, so a package saved in the backup folder is never listed, counted, or pruned as a snapshot.

```
manifest.json
project.json                 { project, tasks, categories, tags, pages, objects, attachments, references }
attachments/<n>.<ext>        original bytes, stored (never compressed); <n> is a sequence number, not an ID or file name
README.txt
```

`manifest.json`:

```json
{
  "format": "minty-notes-project",
  "packageVersion": 1,
  "formatVersion": 4,
  "app": { "name": "Minty Notes", "version": "0.4.2" },
  "createdAt": "…",
  "sourceWorkspaceId": "…",
  "projectName": "…",
  "counts": { "notes": 0, "references": 0, "tasks": 0, "objects": 0, "attachments": 0, "categories": 0, "tags": 0 },
  "records": { "path": "project.json", "size": 0, "sha256": "…" },
  "files": [{ "attachmentId": "…", "path": "attachments/0001.png", "size": 0, "sha256": "…", "mimeType": "image/png" }]
}
```

- **Two version numbers.** `packageVersion` versions this layout; `formatVersion` is the data format of the records inside (`FORMAT_VERSION` of the exporting app). Import accepts `packageVersion` 1 and `formatVersion` 4 … `FORMAT_VERSION`; anything newer is refused with “update the app”, anything older than 4 is refused (packages never existed before format 4). When `FORMAT_VERSION` next changes, `readProjectPackage` must run the same record migrations as `readArchive` for older packages (and get a test).
- **`project.json` is a small self-contained workspace of one project.** The records are ordinary format-4 records with the IDs they had in the source workspace. Every page — the project's notes *and* the reference snapshots — has `location: { kind: 'project', projectId: <the project> }`. No ID in it points outside the package, with one exception: `pageLink` marks in text may name pages that were not included.
- `references: [{ pageId, reasons, from }]` says which pages are **reference snapshots**: copies of pages the project linked to but did not own. `reasons` ⊆ `pinned` | `link` (linked from a project note's text) | `task` (linked from a task) | `suggested` (shared category); `from` is where the page lived in the library, as text (“VTScada › General”, “Standalone notes”, “Inbox”). A snapshot is always a copy of a **library** page: pages of another project and pages hidden for the project are never packaged (see the rules below). A snapshot page carries the categories it had effectively (its own ∪ its section's ∪ its notebook's) and `copiedFrom: { pageId: null, title, at: <export time> }`.
- `project.pinnedPageIds` lists the pinned pages that are in the package as snapshots; `hiddenPageIds` is always empty. Tasks keep only links to pages in the package. A project copy's `copiedFrom.pageId` is kept only when its original is in the package (otherwise `null`). Due dates that are not real dates (possible from app 0.2.0) are written as `null`.
- Attachments are every image used by an included page and every imported original (`importedFrom`) of an included page — the **unchanged original bytes**. The `size` and `sha256` in the package are those of the bytes actually stored. A picture's `mimeType` (and the extension of its path) is the type **its bytes really are**: a browser shows a JPEG that was saved as “photo.png”, so a workspace can hold a picture under another type's name; the exporter packs the bytes unchanged and states the real type (the source workspace is not changed). A “picture” whose bytes are none of the supported types stops the export with a message naming the note, because such a package could not be imported.

### What is included (export rules, `selectProject.ts`)

| | |
|---|---|
| Always | The project record (details, status, due date, contacts, equipment, software, file locations, categories); its **live** notes with all text, tables, code, images with markup/crop/annotations, sketches, and imported drafts with their originals; all its tasks (status, order, priority, date-only due date, completion time); the categories and tags those records use. |
| Reference snapshots, on by default | **Library pages** (pages in a notebook section, standalone notes, the Inbox) that are **pinned** to the project, or **linked directly** from a project note's text or from a task. |
| Reference snapshots, off by default | Library pages **suggested by category** (it can be the whole library for that category). |
| Never, whatever points at them and whatever is ticked | **Pages hidden for this project** (`hiddenPageIds`) — also when a note links to one, a task links to one, or the records list it as pinned as well. **Pages that belong to another project** — also when pinned to this project or linked from its notes or tasks. With them stay out: their text, their objects, their images and original files, their titles, and (for another project) its name. |
| Never | Other projects; the rest of the library; anything in the Trash (project notes, pinned or linked pages); templates; device settings; the hidden list itself; the **contents** of saved file locations (paths and web links travel as text only). |

Links are followed **one step only**: a snapshot's own links to further pages are not followed. A link in a note to a page that is not packaged **stays in the text exactly as written** (the mark keeps the source page ID; it is not removed and not pointed at another page) and arrives as an unavailable link; a task's link to such a page is left off the copied task. The export dialog shows all of this before the download: each page the project pins or links to that is never packaged is listed by title with the reason (“hidden for this project” / “belongs to another project”), where it lives, and how the project points at it, and the other links that lead outside the package are counted by reason (hidden, another project, left out by the choices made, in the Trash, already deleted; task links dropped). The summary is computed by the same selection the export uses, so it describes the file that is written.

**Proposal for later, not built:** explicit inclusion of another project's page (for example a per-page “also pack this page of project X” choice, with that project named in the warning). It needs product decisions first — whose content it is, whether the other project's attachments and originals come along, how it is shown after import, and whether a hidden page could ever be opted in — so the exporter has no such option today.

### Import (`readPackage.ts` → `importPlan.ts` → `Repository.importRecords`)

**Validation before anything is written** (a package is untrusted; any failure refuses the whole file):

- **The ZIP directory is checked before anything is unpacked** (`src/backup/zipReader.ts`, the shared reader, in its strict `minty` layout: only what the app's own writer produces; it reads the list of files and the fixed-size headers, and never copies or decompresses entry data while doing so). File ≤ 1 GiB; starts as a ZIP and ends with its end record (no comment, nothing after it); not split, not ZIP64; **≤ 20,000 entries, judged from the count alone**; per entry: a readable name without control characters, no flags except “UTF-8 name” (so no encryption and no sizes written after the data), method “stored” or “deflate” only, no extra fields or comments, and **the header in front of the data must repeat the directory's name, method, checksum, and both sizes exactly**; a stored entry's two sizes must be equal; entries must follow one another from the first byte of the file up to the directory — **no overlaps, no gaps, no data that belongs to no entry**. Any violation refuses the file as “not written by Minty Notes, or changed afterwards” (or “damaged or cut off”).
- **Names, still before anything is unpacked:** no name twice, no names that differ only by letter case, no unsafe path (`..`, absolute, backslash, drive letter). Then the layout of a package: names exactly `manifest.json`, `project.json`, `README.txt`, or `attachments/<digits>.<ext>`; attachments **stored uncompressed**; `manifest.json` ≤ 8 MiB and `project.json` ≤ 128 MiB (the larger of the recorded packed and unpacked size); total ≤ 2 GiB.
- **Exactly one manifest is ever unpacked**, and only after the checks above made it unique and size-bounded. It is read once — also to recognise a workspace backup chosen by mistake — before layout problems are reported. `README.txt` is never unpacked. Attachments are read in place (a view of the file's own bytes, exactly as long as the ZIP records).
- **Unpacking is bounded by real bytes, not by what the archive says** (`entryBytes`): an entry larger than its limit is not opened; a recorded size that deflate could not produce from that many bytes (more than ≈ 1032 : 1) is refused without inflating; otherwise the entry is inflated in steps of at most 16 KiB (smaller as it nears its recorded size), into memory that grows with the bytes really produced, and **refused within about 1 MiB of passing its recorded size** — and afterwards if it came out shorter or its CRC-32 differs. This applies to `manifest.json` and `project.json` alike. For `project.json` the manifest's `records.size` must also equal the ZIP's recorded size before it is unpacked, and the unpacked bytes must match `records.sha256`.
- Manifest: format name, versions (above), the checksum entry, and one entry per attachment (unique IDs and paths; every `attachments/` file must be listed).
- `project.json`: size and SHA-256; counts ≤ 5,000 pages, 100,000 objects, 20,000 tasks, 10,000 attachments, 2,000 categories, 2,000 tags; then **the same record and relationship checks as a backup restore** (`validateRecords`: shapes, timestamps, unique IDs, statuses, date-only due dates, rich text against the editor schema, table spans, markup, import details, every link) on the package as a one-project workspace; plus package rules: every page and task belongs to the one project; no page in the Trash; no hidden list; pins only on snapshots; `references` valid and unique; text lengths (names ≤ 2,000, other text ≤ 200,000 characters, lists ≤ 2,000 entries); page width 100–20,000; object coordinates ≤ 10,000,000.
- Files: every attachment present; size and SHA-256 equal to **both** the manifest and the record; every file must be used by a note, either as a picture or as an imported original (never both).
- **File contents are judged from their bytes** (`attachmentCheck.ts`; a matching checksum only proves a file was not changed after export). A picture must be declared as one of the seven types the app accepts — `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/bmp`, `image/avif`, `image/svg+xml` — **and its bytes must be that type**: PNG signature and `IHDR`; JPEG start marker; `GIF87a`/`GIF89a`; `RIFF…WEBP`; `BM` with a known header size; an ISO-media `ftyp` box with brand `avif`/`avis`; for SVG, text (UTF-8 or UTF-16 with a byte-order mark, no control characters) whose first element — after an optional XML declaration, comments, and DOCTYPE — is `<svg>`. PNG bytes declared as SVG, SVG or HTML or plain text declared as PNG, a JPEG declared as PNG, and any other `image/*` type are refused. An imported original must pass the same checks as “Import document”: `detectFormat` (the `%PDF-` marker, or a ZIP signature) and, for DOCX, `checkDocxContainer`: the container's ZIP structure is checked like a backup's (every part's header inside the file and in agreement with the directory, no overlaps, no part listed twice, not encrypted — data descriptors, extra fields, comments, and ZIP64 records, which Word, LibreOffice, and other writers use, are fine); it contains `word/document.xml`, ≤ 5,000 parts, ≤ 300 MB declared; and **every part unpacks to exactly its recorded size and CRC** (bounded, nothing kept). Since the second audit a checksum-correct package cannot carry a container whose directory points outside the file (the audited 138-byte example) or that otherwise could not be opened. Nothing is decoded, rendered, or run during these checks. Pictures are only ever shown through `<img>` (as before), where an SVG cannot run scripts or load external resources.
- Then the records are **rebuilt from their known fields only** (`cleanRecords.ts`): unknown properties are dropped; rich text is re-serialised through the editor schema; link marks whose address is not `http`, `https`, `ftp(s)`, `mailto`, `tel`, `callto`, `sms`, `cid`, `xmpp`, or scheme-less are removed (the words stay) and the rest get the editor's own `target`/`rel`; timestamps are normalised to ISO-8601; an original's file name loses path characters and always ends in `.pdf`/`.docx`. Nothing in a package is ever executed.

**New IDs and relationships.** Every imported record gets a new ID (`crypto.randomUUID()`, retried if the ID already exists in the workspace or anywhere in the package), through one explicit old → new map per kind:

| In the package | In the importing workspace |
|---|---|
| project `id` | new; `name` kept, or “Name (imported)”, “Name (imported 2)”, … when another project (also archived or trashed) has that name ignoring case and accents; `order` after the existing projects; `archivedAt`/`trashedAt` cleared; `updatedAt` = import time |
| contact / equipment / software / file-location `id` | new |
| page `id` (notes and snapshots) | new; `location.projectId` → the new project; `order` 1…n in the package's order (notes first, in their order in the source project, then snapshots); `createdAt` and `updatedAt` kept — these three decide the order of the notes in the project's sidebar, so it is the same as in the source project (see `ARCHITECTURE.md`, “Order of a project's notes”) |
| snapshot page | an ordinary page owned by the new project with `copiedFrom: { pageId: null, title, at }` (“Project copy”); `project.pinnedPageIds` is empty |
| `copiedFrom.pageId` of a project copy | → the new ID of its original if that came along, else `null` |
| object `id`, `pageId` | new; → new page |
| `ImageObject.attachmentId`, `importedFrom.attachmentId` | → new attachment ID (always a new record and its own copy of the bytes, also when identical bytes exist) |
| markup annotation `id` | kept (unique only inside its own markup) |
| task `id`, `projectId`, `linkedPageIds` | new; → new project; → new page IDs |
| `pageLink` mark → a page in the package | → that page's new ID |
| `pageLink` mark → anything else | → a fresh ID that belongs to no page (one per old target), so it shows as an unavailable link and can never resolve to a page of the importing workspace |
| category / tag | the existing record **with the same name** (ignoring case and accents) is used as it is, otherwise a new one — never matched by ID |
| `hiddenPageIds` | empty |

An import therefore links to existing records only for same-named categories and tags, and — only if the user chooses it — for **reference pages that are the same pages of the same library**: offered when the package's `sourceWorkspaceId` equals this workspace's ID and a live library page has the same ID and `createdAt` (e.g. a second computer restored from the same backup). Then that page is pinned (`pinnedPageIds`) instead of copied, and links and task links point at it. Matching titles or categories never link anything. No existing record is ever modified.

**Writing.** `WorkspaceStore.addImportedRecords` saves pending edits first (and stops if that fails), builds the plan against the workspace exactly as stored, checks it again (`verifyImportPlan`: no new ID exists; every relationship resolves inside the import or to an explicitly reused record; `validateRecords` once more on the new records), and calls `Repository.importRecords`: **one IndexedDB transaction** over all record stores, `attachments`, `blobs`, and `settings` that checks the editor-owner token, checks that every new ID is unused and every reused record still exists, writes with `add` (which the browser itself refuses for an existing key), and increases `activity.revision` by one. Any failure — validation, ownership, a taken ID, quota, a closed tab — leaves the workspace exactly as it was. A read-only window cannot import.

**Not a sanitized file.** A package contains the original image bytes also where the page shows a redaction box, blur, or crop, and the original DOCX/PDF files. Only “Save PNG copy” and note-to-PDF produce flattened, share-safe files.

## Migrations

- Older archive versions are migrated in `readArchive` before validation (format 1 → 2 above); newer ones are refused with "update the app".
- Older archive versions are migrated in order: format 1 → 2 → 3 → 4.
- Tests: `src/storage/db.test.ts` (DB 1 → 5 and 2 → 5 with Stage 1 notes, IDs, layout, and attachment bytes; DB 3 → 5 with Stage 2 projects, links, and file locations; **DB 4 → 5 with every Stage 3 record kept byte for byte, then tables and page links saved, backed up, and restored**; a failed migration leaves version 2, 3, or 4 untouched), `src/store/projects.test.ts`, `src/store/tasks.test.ts`, `src/backup/backup.test.ts` (format-1 and format-2 archives, including the trashed-orphan and invalid-due-date repairs), `src/import/import.test.ts` (a format-3 archive restores as format 4), `src/store/richNotes.test.ts`, and `src/store/markup.test.ts`.
- Held-edit reconciliation (`src/store/reconcile.ts`) merges `markup` and `importedFrom` as whole fields; a markup changed in both windows keeps the other window's version and places this window's marked-up copy (same attachment) on the “Recovered changes” page. It treats `categoryIds`, `tagIds`, `pinnedPageIds`, `hiddenPageIds`, and a task's `linkedPageIds` as sets (both windows' additions and removals are kept) and finally removes any ID that points at a record deleted in either window, including task links and template references. Template fields (`notes`, `tasks`, `project`) merge as whole fields.
- IndexedDB upgrades go in `openMintyDB`'s `upgrade` callback, keyed on `oldVersion`. Another open window is told to reload (`blocking`).
- Portable project packages have their own `packageVersion` (1). They hold format-4 records; no migration exists or is needed yet. Tests: `src/portable/projectExport.test.ts`, `projectImport.test.ts`, `packageValidation.test.ts`, `zipSafety.test.ts`.
- Backup files of every earlier release: `src/backup/archiveCompat.test.ts` restores one written by each release's own code (0.1.0 → 0.4.1) and five zipped again by ZIP tools; `src/backup/archiveSafety.test.ts` and `src/backup/zipReader.test.ts` cover hostile archives. The second audit changed how a backup's ZIP is read, not what a backup contains: `FORMAT_VERSION` stays 4 and the writer is unchanged.
- The checks added after the 0.4.2 audit (strict ZIP structure, real picture types, hidden and other-project pages never packaged) did not change the package layout, so `packageVersion` stays 1. A package made by a pre-audit 0.4.2 build still imports unless it contains a picture stored under another type's name (export it again) — and such a package may contain a page of another project, which is imported as the ordinary “Project copy” page it is in the file.
